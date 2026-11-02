#include "session_supervisor.h"

#import <Foundation/Foundation.h>
#import <CoreFoundation/CoreFoundation.h>
#import <Security/Security.h>
#import <dispatch/dispatch.h>

#include <errno.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>

#include "authority_client.h"
#include "capture_owner.h"
#include "cua_desktop_session_pins.h"
#include "machine_lease.h"
#include "peer_auth.h"
#include "peer_socket.h"
#include "session_binding.h"
#include "session_capture_file.h"
#include "session_control.h"
#include "window_identity.h"

namespace zody::cua::desktop_session {
namespace {

constexpr size_t kAuthorityMaxLineBytes = 16 * 1024;
constexpr size_t kAuthorityMaxBufferBytes = 64 * 1024;
constexpr int kAuthorityIoTimeoutMs = 10'000;

bool wait_fd(int fd, short events, int timeout_ms) {
  struct pollfd descriptor {};
  descriptor.fd = fd;
  descriptor.events = events;
  int result = 0;
  do {
    result = poll(&descriptor, 1, timeout_ms);
  } while (result < 0 && errno == EINTR);
  if (result <= 0) return false;
  // 中文原因：peer 关闭时 poll 可能只报 POLLHUP/POLLERR 而不带 POLLIN；
  // 必须让上层继续 recv 以得到真实 EOF，否则 owner 失效会被误判成 timeout。
  return (descriptor.revents & (events | POLLHUP | POLLERR)) != 0;
}

bool send_all(int fd, const std::string& bytes, std::string& error) {
  size_t offset = 0;
  const auto deadline = std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(kAuthorityIoTimeoutMs);
  while (offset < bytes.size()) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                               deadline - std::chrono::steady_clock::now())
                               .count();
    if (remaining <= 0) {
      error = "authority write timed out";
      return false;
    }
    if (!wait_fd(fd, POLLOUT, static_cast<int>(remaining))) {
      error = "authority write timed out";
      return false;
    }
    const ssize_t count =
        send(fd, bytes.data() + offset, bytes.size() - offset, MSG_NOSIGNAL);
    if (count < 0) {
      if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue;
      error = std::string("authority write failed: ") + std::strerror(errno);
      return false;
    }
    offset += static_cast<size_t>(count);
  }
  return true;
}

}  // namespace

class AuthorityFdReader {
 public:
  explicit AuthorityFdReader(int fd) : fd_(fd) {}

  bool request(NSString* method, NSDictionary* payload, NSDictionary** result,
               std::string& error) {
    if (result != nullptr) *result = nil;
    if (canceled_) {
      error = cancel_reason_;
      return false;
    }
    const std::string request_id = "native-" + std::to_string(next_request_++);
    NSDictionary* frame = @{
      @"requestId" : [NSString stringWithUTF8String:request_id.c_str()],
      @"method" : method,
      @"payload" : payload == nil ? @{} : payload,
    };
    NSError* json_error = nil;
    NSData* data = [NSJSONSerialization dataWithJSONObject:frame options:0 error:&json_error];
    if (data == nil || json_error != nil) {
      error = "authority request serialization failed";
      return false;
    }
    std::string line(static_cast<const char*>(data.bytes), data.length);
    line.push_back('\n');
    if (!send_all(fd_, line, error)) return false;

    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::milliseconds(kAuthorityIoTimeoutMs);
    while (true) {
      const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                                 deadline - std::chrono::steady_clock::now())
                                 .count();
      if (remaining <= 0) {
        error = "authority response timed out";
        return false;
      }
      std::string response;
      const ReadStatus status = read_line(static_cast<int>(remaining), response, error);
      if (status != ReadStatus::Line) {
        if (status == ReadStatus::Timeout) error = "authority response timed out";
        return false;
      }
      NSDictionary* parsed = nil;
      if (!parse_object(response, &parsed, error)) return false;
      std::string method_name;
      const FieldStatus method_status = string_field(parsed, @"method", method_name);
      if (method_status == FieldStatus::Invalid) {
        canceled_ = true;
        cancel_reason_ = "invalid-authority-method-field";
        error = cancel_reason_;
        return false;
      }
      if (method_status == FieldStatus::Valid && method_name == "revoked") {
        canceled_ = true;
        cancel_reason_ = "owner-invalidated";
        error = cancel_reason_;
        return false;
      }
      std::string response_id;
      if (string_field(parsed, @"requestId", response_id) != FieldStatus::Valid ||
          response_id != request_id) {
        canceled_ = true;
        cancel_reason_ = "unexpected-authority-frame";
        error = cancel_reason_;
        return false;
      }
      if (result != nullptr) *result = parsed[@"result"];
      return true;
    }
  }

  // 等待期间也必须持续处理 owner 失效/EOF；完整 line 被消费后返回 true。
  bool pollCancel(int timeout_ms, std::string& reason) {
    if (canceled_) {
      reason = cancel_reason_;
      return true;
    }
    std::string response;
    std::string error;
    const ReadStatus status = read_line(timeout_ms, response, error);
    if (status == ReadStatus::Timeout) return false;
    if (status == ReadStatus::Eof) {
      canceled_ = true;
      cancel_reason_ = "authority-eof";
      reason = cancel_reason_;
      return true;
    }
    if (status == ReadStatus::Error) {
      canceled_ = true;
      cancel_reason_ = error.empty() ? "authority-read-error" : error;
      reason = cancel_reason_;
      return true;
    }
    NSDictionary* parsed = nil;
    if (!parse_object(response, &parsed, error)) {
      canceled_ = true;
      cancel_reason_ = error;
      reason = cancel_reason_;
      return true;
    }
    std::string method_name;
    const FieldStatus method_status = string_field(parsed, @"method", method_name);
    if (method_status == FieldStatus::Invalid) {
      canceled_ = true;
      cancel_reason_ = "invalid-authority-method-field";
      reason = cancel_reason_;
      return true;
    }
    if (method_status == FieldStatus::Valid && method_name == "revoked") {
      canceled_ = true;
      cancel_reason_ = "owner-invalidated";
      reason = cancel_reason_;
      return true;
    }
    canceled_ = true;
    cancel_reason_ = "unexpected-authority-frame";
    reason = cancel_reason_;
    return true;
  }

  bool has_buffered_bytes() const { return !buffer_.empty(); }

 private:
  enum class ReadStatus { Line, Timeout, Eof, Error };
  enum class FieldStatus { Absent, Valid, Invalid };

  // 中文原因：UTF8String 在嵌入 NUL 处截断，会让 "native-1\u0000xxx" 与
  // "native-1" 误匹配。必须按 NSData 长度保留原始字节，并拒绝任何 C0/DEL。
  static FieldStatus string_field(NSDictionary* frame, NSString* key, std::string& out) {
    out.clear();
    id value = frame[key];
    if (value == nil) return FieldStatus::Absent;
    if (![value isKindOfClass:[NSString class]]) return FieldStatus::Invalid;
    NSData* data = [static_cast<NSString*>(value)
        dataUsingEncoding:NSUTF8StringEncoding
        allowLossyConversion:NO];
    if (data == nil) return FieldStatus::Invalid;
    out.assign(static_cast<const char*>(data.bytes), data.length);
    for (unsigned char byte : out) {
      if (byte < 0x20 || byte == 0x7f) return FieldStatus::Invalid;
    }
    return FieldStatus::Valid;
  }

  static bool parse_object(const std::string& line, NSDictionary** frame, std::string& error) {
    NSData* data = [NSData dataWithBytes:line.data() length:line.size()];
    NSError* json_error = nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&json_error];
    if (parsed == nil || json_error != nil || ![parsed isKindOfClass:[NSDictionary class]]) {
      error = "authority frame is not a JSON object";
      return false;
    }
    *frame = static_cast<NSDictionary*>(parsed);
    return true;
  }

  ReadStatus read_line(int timeout_ms, std::string& line, std::string& error) {
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::milliseconds(timeout_ms);
    while (true) {
      const size_t newline = buffer_.find('\n');
      if (newline != std::string::npos) {
        line = buffer_.substr(0, newline);
        buffer_.erase(0, newline + 1);
        if (line.empty()) continue;
        if (line.size() > kAuthorityMaxLineBytes) {
          error = "authority line exceeds bound";
          return ReadStatus::Error;
        }
        return ReadStatus::Line;
      }
      if (buffer_.size() > kAuthorityMaxBufferBytes) {
        error = "authority buffer exceeds bound";
        return ReadStatus::Error;
      }
      const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                                 deadline - std::chrono::steady_clock::now())
                                 .count();
      if (remaining < 0) return ReadStatus::Timeout;
      // timeout 0 也要做一次非阻塞 poll，否则等待确认时无法消费刚到达的 revoked/EOF。
      if (!wait_fd(fd_, POLLIN, remaining > 0 ? static_cast<int>(remaining) : 0)) {
        if (errno == EINTR) continue;
        return ReadStatus::Timeout;
      }
      char chunk[4096];
      const ssize_t count = recv(fd_, chunk, sizeof(chunk), 0);
      if (count == 0) return ReadStatus::Eof;
      if (count < 0) {
        if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue;
        error = std::string("authority read failed: ") + std::strerror(errno);
        return ReadStatus::Error;
      }
      buffer_.append(chunk, static_cast<size_t>(count));
    }
  }

  int fd_;
  uint64_t next_request_ = 1;
  std::string buffer_;
  bool canceled_ = false;
  std::string cancel_reason_;
};

namespace {

std::string ns_utf8(NSString* value) {
  if (![value isKindOfClass:[NSString class]]) return "";
  NSData* data = [value dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  if (data == nil) return "";
  return std::string(static_cast<const char*>(data.bytes), data.length);
}

NSString* ns_string(const std::string& value) {
  return [[NSString alloc] initWithBytes:value.data()
                                  length:value.size()
                                encoding:NSUTF8StringEncoding];
}

bool binding_from_bootstrap(NSDictionary* result, const std::string& expected_producer,
                            SessionBinding& binding, std::string& error) {
  if (![result isKindOfClass:[NSDictionary class]] || ![result[@"ok"] boolValue]) {
    error = "authority-bootstrap-rejected";
    return false;
  }
  const std::string producer = ns_utf8(result[@"producerIncarnation"]);
  if (producer != expected_producer) {
    error = "bootstrap-producer-mismatch";
    return false;
  }
  NSDictionary* ref = result[@"ref"];
  NSDictionary* target = result[@"target"];
  if (![ref isKindOfClass:[NSDictionary class]] || ![target isKindOfClass:[NSDictionary class]]) {
    error = "bootstrap-ref-or-target-missing";
    return false;
  }
  NSDictionary* frame = @{
    @"traceId" : result[@"traceId"] == nil ? @"" : result[@"traceId"],
    @"producerIncarnation" : result[@"producerIncarnation"],
    @"runId" : result[@"runId"] == nil ? @"" : result[@"runId"],
    @"turnId" : result[@"turnId"] == nil ? @"" : result[@"turnId"],
    @"ref" : ref,
    @"target" : target,
  };
  return parse_session_binding(frame, binding, error);
}

NSDictionary* association_payload(const SessionBinding& binding) {
  return @{
    @"ref" : session_ref_dictionary(binding),
    @"traceId" : ns_string(binding.trace_id),
    @"producerIncarnation" : ns_string(binding.producer_incarnation),
    @"runId" : ns_string(binding.run_id),
    @"turnId" : ns_string(binding.turn_id),
  };
}

bool response_matches_binding(NSDictionary* result, const SessionBinding& binding,
                              std::string& error) {
  if (![result isKindOfClass:[NSDictionary class]] || ![result[@"ok"] boolValue]) {
    error = "authority-check-rejected";
    return false;
  }
  NSDictionary* ref = result[@"ref"];
  if (![ref isKindOfClass:[NSDictionary class]]) {
    error = "authority-check-ref-missing";
    return false;
  }
  NSDictionary* frame = @{
    @"traceId" : result[@"traceId"] == nil ? @"" : result[@"traceId"],
    @"producerIncarnation" :
        result[@"producerIncarnation"] == nil ? @"" : result[@"producerIncarnation"],
    @"runId" : result[@"runId"] == nil ? @"" : result[@"runId"],
    @"turnId" : result[@"turnId"] == nil ? @"" : result[@"turnId"],
    @"ref" : ref,
    @"target" : @{
      @"pid" : @(binding.target.pid),
      @"windowId" : @(binding.target.window_id),
    },
  };
  SessionBinding response;
  if (!parse_session_binding(frame, response, error)) return false;
  if (!response.same_scope(binding)) {
    error = "authority-check-scope-mismatch";
    return false;
  }
  NSDictionary* projection = result[@"projection"];
  if (![projection isKindOfClass:[NSDictionary class]] ||
      ![projection[@"status"] isEqualToString:@"candidate"]) {
    error = "authority-check-not-candidate";
    return false;
  }
  return true;
}

bool node_loaded_code_ok(pid_t pid, std::string& error) {
  zody::cua::round11::LoadedCodeExpectation expected;
  expected.identifier = CUA_DESKTOP_SESSION_NODE_IDENTIFIER;
  expected.leaf_certificate_sha256 = CUA_DESKTOP_SESSION_NODE_LEAF_SHA256;
  expected.designated_requirement = CUA_DESKTOP_SESSION_NODE_DESIGNATED_REQUIREMENT;
  expected.cdhash_hex = CUA_DESKTOP_SESSION_NODE_CDHASH;
  expected.require_empty_entitlements = true;
  const zody::cua::round11::LoadedCodeResult loaded =
      zody::cua::round11::verify_loaded_code_for_pid(pid, expected);
  if (!loaded.ok) {
    error = "node-loaded-code: " + loaded.reason;
    return false;
  }
  return true;
}

std::string capture_file_name() {
  unsigned char bytes[16];
  if (SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes) != errSecSuccess) return "";
  static const char* hex = "0123456789abcdef";
  std::string name = "capture-";
  for (unsigned char byte : bytes) {
    name.push_back(hex[(byte >> 4) & 0x0f]);
    name.push_back(hex[byte & 0x0f]);
  }
  name += ".png";
  return name;
}

bool send_bounded_close(AuthorityFdReader& reader) {
  std::string error;
  NSDictionary* result = nil;
  return reader.request(@"close", @{}, &result, error);
}

bool strict_true_bool(id value) {
  return value != nil && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID() &&
         [value boolValue];
}

bool strict_capture_result_ack(id value) {
  // 中文原因：boolValue 会把字符串/数字等非布尔 JSON 也当成 true。captureResult
  // 的 ack 必须精确为 {ok:<bool true>, accepted:<bool true>}，不能放宽 shape。
  if (![value isKindOfClass:[NSDictionary class]]) return false;
  NSDictionary* ack = static_cast<NSDictionary*>(value);
  if (ack.count != 2 || ack[@"ok"] == nil || ack[@"accepted"] == nil) return false;
  return strict_true_bool(ack[@"ok"]) && strict_true_bool(ack[@"accepted"]);
}

// 诊断只输出固定 reason，不回显 authority/窗口/路径等动态内容。
std::string fixed_capture_failure_reason(const std::string& error) {
  const auto starts = [&error](const char* prefix) { return error.rfind(prefix, 0) == 0; };
  if (error.empty()) return "connection-failed";
  if (error == "entry-clean-exit") return "entry-clean-exit";
  if (starts("entry-fatal:")) return "entry-fatal";
  if (error == "entry-stopped") return "entry-stopped";
  if (starts("session-stopping")) return "session-stopping";
  if (starts("confirmation-unavailable")) return "confirmation-unavailable";
  if (starts("confirmation-denied")) return "confirmation-denied";
  if (starts("user-canceled")) return "user-canceled";
  if (starts("owner-invalidated") || starts("confirmation-invalidated") ||
      starts("confirmation-stale"))
    return "confirmation-invalidated";
  if (starts("confirmation-canceled")) return "confirmation-canceled";
  if (starts("peer-auth:")) return "peer-auth-failed";
  if (error == "peer-pid-mismatch") return "peer-pid-mismatch";
  if (starts("node-loaded-code:")) return "node-loaded-code-mismatch";
  if (starts("bootstrap:")) return "bootstrap-failed";
  if (starts("binding")) return "binding-invalid";
  if (starts("target-") || starts("window-")) return "window-target-invalid";
  if (error == "machine-busy" || error == "machine-lease-invalid")
    return "machine-lease-unavailable";
  if (error == "capture-file-name-unavailable") return "capture-file-name-unavailable";
  if (starts("capture-file-verify:")) return "capture-file-verify-failed";
  if (starts("capture-canceled")) return "capture-canceled";
  if (starts("capture-result-not-accepted")) return "capture-result-not-accepted";
  if (starts("capture-result:")) return "capture-result-transport-failed";
  if (error == "machine-lease-release-not-confirmed")
    return "machine-lease-release-unconfirmed";
  if (starts("final-check:")) return "final-owner-check-failed";
  if (starts("post-confirm-check")) return "post-confirm-check-failed";
  if (error == "authority-reader-buffer-not-empty") return "authority-buffer-not-empty";
  if (starts("capture-failed") || starts("visual-") || starts("tcc-") ||
      starts("capture-context") || starts("machine-lease-not-held") ||
      starts("authority-revoke") || starts("write-"))
    return "capture-failed";
  if (starts("peer-")) return "peer-rejected";
  if (starts("control-")) return "control-failed";
  if (starts("transport-")) return "transport-closed";
  if (starts("authority-")) return "authority-failed";
  if (error == "unexpected-control-frame") return "unexpected-control-frame";
  return "connection-failed";
}

void log_capture_rejected(const std::string& error) {
  std::fprintf(stderr, "[cua-native] capture-rejected {\"reason\":\"%s\"}\n",
               fixed_capture_failure_reason(error).c_str());
  std::fflush(stderr);
}

void log_capture_delivered(const zody::cua::round11::CaptureOutcome& outcome,
                           size_t png_bytes) {
  std::fprintf(stderr,
               "[cua-native] capture-delivered {\"sha256\":\"%s\",\"width\":%u,"
               "\"height\":%u,\"bytes\":%zu,\"resourcesReleased\":true,"
               "\"machineLeaseReleased\":true}\n",
               outcome.png_sha256.c_str(), outcome.width, outcome.height, png_bytes);
  std::fflush(stderr);
}

}  // namespace

SessionSupervisor::SessionSupervisor(SessionLaunch& launch,
                                     ConfirmationController& confirmation)
    : launch_(launch), confirmation_(confirmation) {}

SessionSupervisor::~SessionSupervisor() { requestStop("supervisor-destroyed"); }

SessionSupervisor::OwnedFd::~OwnedFd() {
  if (fd_ >= 0) ::close(fd_);
}

int SessionSupervisor::OwnedFd::release() {
  const int fd = fd_;
  fd_ = -1;
  return fd;
}

void SessionSupervisor::requestStop(const std::string& reason) {
  const std::string effective_reason = reason.empty() ? "stopped" : reason;
  {
    std::lock_guard<std::mutex> lock(stop_mutex_);
    if (!stop_.load(std::memory_order_acquire)) stop_reason_ = effective_reason;
  }
  stop_.store(true, std::memory_order_release);

  uint64_t generation = 0;
  {
    // 中文原因：capture_once 阻塞在 authority/visual 等待时看不到 stop_ 标志；
    // 必须 shutdown 同一活动连接让 reader 走 EOF/cancel，同时保持 lease 不变。
    std::lock_guard<std::mutex> lock(active_mutex_);
    generation = active_generation_;
    if (active_authority_ != nullptr) {
      active_authority_->interrupt();
    } else if (active_fd_ >= 0) {
      (void)shutdown(active_fd_, SHUT_RDWR);
    }
  }
  // 确认拒绝先在状态机内同步锁存，窗口关闭由 invalidate 自己派发主线程。
  if (generation != 0) confirmation_.invalidate(generation, effective_reason);
}

void SessionSupervisor::markFatal(const std::string& reason) {
  if (exit_code_ == 0) {
    exit_code_ = 1;
    failure_reason_ = reason.empty() ? "session-fatal" : reason;
  }
}

bool SessionSupervisor::is_fatal_exit_reason(const std::string& reason) const {
  return reason.rfind("entry-fatal:", 0) == 0 || reason == "entry-eof" ||
         reason == "control-read-error" || reason == "unexpected-control-frame";
}

std::string SessionSupervisor::classify_control_eof() {
  // 中文原因：正常 Host Dispose 先关闭 fd3 再以 0 退出，EOF 与 waitpid 回收
  // 存在竞态；必须等真实 child 状态。只有已回收 exit0 才算正常结束，非零、
  // 信号或 EOF 后仍存活都保持 fatal，不能把 EOF 一律当成功或失败。
  if (!launch_.node.wait_for_exit_status(2'000)) return "entry-eof";
  return launch_.node.exited_cleanly() ? "entry-clean-exit" : "entry-eof";
}

void SessionSupervisor::stop_main_loop_once() {
  if (!main_loop_stopped_.exchange(true)) ConfirmationController::stopMainLoop();
}

void SessionSupervisor::set_active_fd(int fd) {
  std::lock_guard<std::mutex> lock(active_mutex_);
  active_fd_ = fd;
  active_authority_ = nullptr;
}

void SessionSupervisor::promote_active_authority(
    zody::cua::round11::AuthorityClient* authority, int fd) {
  std::lock_guard<std::mutex> lock(active_mutex_);
  active_authority_ = authority;
  active_fd_ = fd;
}

void SessionSupervisor::clear_active_connection() {
  std::lock_guard<std::mutex> lock(active_mutex_);
  active_authority_ = nullptr;
  active_fd_ = -1;
}

void SessionSupervisor::set_active_generation(uint64_t generation) {
  std::lock_guard<std::mutex> lock(active_mutex_);
  active_generation_ = generation;
}

void SessionSupervisor::clear_active_generation(uint64_t generation) {
  std::lock_guard<std::mutex> lock(active_mutex_);
  if (active_generation_ == generation) active_generation_ = 0;
}

void SessionSupervisor::run() {
  SessionControl control(launch_.node.control_fd);
  control_ = &control;
  while (!stop_.load(std::memory_order_acquire)) {
    int fd = -1;
    std::string error;
    if (!accept_one_with_deadline(launch_.authority_listener, 500, fd, error)) {
      if (stop_.load(std::memory_order_acquire)) break;
      // 空闲时也观察 entry 退出/stop，避免留下无人接管的 native 进程。
      std::string reason;
      const bool canceled = poll_cancellation(reason);
      if (canceled) {
        if (is_fatal_exit_reason(reason)) markFatal(reason);
        {
          std::lock_guard<std::mutex> lock(stop_mutex_);
          stop_reason_ = reason;
        }
        stop_.store(true, std::memory_order_release);
        break;
      }
      continue;
    }
    OwnedFd connection(fd);
    set_active_fd(connection.get());
    std::string connection_error;
    const bool connected = handle_connection(connection, connection_error);
    clear_active_connection();
    if (!connected) {
      if (connection_error != "entry-clean-exit") log_capture_rejected(connection_error);
      if (connection_error == "entry-clean-exit") {
        {
          std::lock_guard<std::mutex> lock(stop_mutex_);
          stop_reason_ = connection_error;
        }
        stop_.store(true, std::memory_order_release);
        break;
      }
      if (connection_error == "fatal-resource-release-unknown") {
        markFatal(connection_error);
        stop_.store(true, std::memory_order_release);
        break;
      }
      if (is_fatal_exit_reason(connection_error)) {
        markFatal(connection_error);
        stop_.store(true, std::memory_order_release);
        break;
      }
    }
  }
  stop_main_loop_once();
}

bool SessionSupervisor::poll_cancellation(std::string& reason) {
  if (stop_.load(std::memory_order_acquire)) {
    std::lock_guard<std::mutex> lock(stop_mutex_);
    reason = stop_reason_;
    return true;
  }
  if (authority_reader_ != nullptr && authority_reader_->pollCancel(0, reason)) return true;
  if (control_ != nullptr) {
    NSDictionary* frame = nil;
    std::string error;
    const SessionControlStatus status = control_->read_frame(0, &frame, error);
    if (status == SessionControlStatus::Timeout) return false;
    if (status == SessionControlStatus::Eof) {
      reason = classify_control_eof();
      return true;
    }
    if (status == SessionControlStatus::Error) {
      reason = error.empty() ? "control-read-error" : error;
      return true;
    }
    if (is_stop_frame(frame)) {
      reason = "entry-stopped";
      return true;
    }
    std::string fatal_reason;
    if (parse_fatal_frame(frame, fatal_reason)) {
      // 中文原因：entry 已捕获 Node 运行时异常但可能仍以 0 退出；native 必须
      // 保留这一事实并以非零退出，不能把 hello/Dispose 当成完整加载成功。
      reason = "entry-fatal:" + fatal_reason;
      return true;
    }
    CaptureTargetRequest requested_target;
    std::string request_error;
    if (parse_capture_request(frame, requested_target, request_error)) {
      // 中文原因：fd3 的 capture-request 只是入口的提示，不是授权或目标事实；
      // 真实 target 必须由同一 live scope 的 authority bootstrap 响应给出，
      // 因此这里消费后继续等待实际 authority 连接，不能把提示当成 stop。
      return false;
    }
    reason = "unexpected-control-frame";
    return true;
  }
  return false;
}

bool SessionSupervisor::wait_for_decision(uint64_t generation, bool& allowed,
                                          std::string& reason) {
  while (true) {
    std::unique_lock<std::mutex> lock(decision_mutex_);
    if (decided_) {
      allowed = allowed_;
      reason = decision_reason_;
      return true;
    }
    decision_cv_.wait_for(lock, std::chrono::milliseconds(250));
    if (decided_) {
      allowed = allowed_;
      reason = decision_reason_;
      return true;
    }
    lock.unlock();
    std::string cancel_reason;
    if (poll_cancellation(cancel_reason)) {
      confirmation_.invalidate(generation, cancel_reason);
      std::unique_lock<std::mutex> wait_lock(decision_mutex_);
      decision_cv_.wait_for(wait_lock, std::chrono::seconds(1), [&] { return decided_; });
      if (!decided_) {
        allowed = false;
        reason = cancel_reason;
        return true;
      }
    }
  }
}

bool SessionSupervisor::handle_connection(OwnedFd& connection, std::string& error) {
  if (stop_.load(std::memory_order_acquire)) {
    error = "session-stopping";
    return false;
  }

  const int fd = connection.get();

  zody::cua::round11::PeerExpectation expectation;
  expectation.pid = launch_.node.pid;
  expectation.uid = geteuid();
  expectation.bundle_id = CUA_DESKTOP_SESSION_NODE_IDENTIFIER;
  expectation.leaf_certificate_sha256 = CUA_DESKTOP_SESSION_NODE_LEAF_SHA256;
  expectation.designated_requirement = CUA_DESKTOP_SESSION_NODE_DESIGNATED_REQUIREMENT;
  expectation.require_empty_entitlements = true;
  const zody::cua::round11::PeerAuthResult peer =
      zody::cua::round11::authenticate_peer_fd(fd, expectation);
  if (!peer.ok) {
    error = "peer-auth: " + peer.reason;
    return false;
  }
  if (peer.peer_pid != launch_.node.pid) {
    error = "peer-pid-mismatch";
    return false;
  }
  if (!node_loaded_code_ok(static_cast<pid_t>(peer.peer_pid), error)) return false;

  AuthorityFdReader reader(fd);
  authority_reader_ = &reader;
  auto reset_observation = [this]() { authority_reader_ = nullptr; };

  NSDictionary* bootstrap = nil;
  std::string bootstrap_error;
  // bootstrap 必须为空 payload；target 只能由真实 tool call 的 capture composition
  // 在 TS owner 内配置，并由同一 live scope 的 bootstrap 响应返回。
  if (!reader.request(@"bootstrap", @{}, &bootstrap, bootstrap_error)) {
    error = "bootstrap: " + bootstrap_error;
    reset_observation();
    return false;
  }
  SessionBinding binding;
  if (!binding_from_bootstrap(bootstrap, launch_.producer_incarnation, binding, error)) {
    reset_observation();
    return false;
  }

  SessionTarget os_target;
  if (!resolve_window_target(binding.target.pid, binding.target.window_id, os_target, error)) {
    send_bounded_close(reader);
    reset_observation();
    return false;
  }
  binding.target.layer = os_target.layer;
  binding.target.x = os_target.x;
  binding.target.y = os_target.y;
  binding.target.width = os_target.width;
  binding.target.height = os_target.height;
  binding.target.owner_name = os_target.owner_name;
  binding.target.window_name = os_target.window_name;
  if (!binding.valid()) {
    error = "binding-invalid-after-os-resolution";
    send_bounded_close(reader);
    reset_observation();
    return false;
  }

  if (stop_.load(std::memory_order_acquire)) {
    // 停止/失效已锁存时不得再弹出新确认窗口；否则会出现 stop 后仍可点击的窗口。
    error = "session-stopping-before-confirmation";
    send_bounded_close(reader);
    reset_observation();
    return false;
  }

  {
    std::lock_guard<std::mutex> lock(decision_mutex_);
    decided_ = false;
    allowed_ = false;
    decision_reason_.clear();
  }
  __block uint64_t generation = 0;
  dispatch_sync(dispatch_get_main_queue(), ^{
    generation = this->confirmation_.present(
        binding, [this](bool allowed, const std::string& reason) {
          std::lock_guard<std::mutex> lock(this->decision_mutex_);
          this->decided_ = true;
          this->allowed_ = allowed;
          this->decision_reason_ = reason;
          this->decision_cv_.notify_all();
        });
  });
  if (generation == 0) {
    error = "confirmation-unavailable-or-busy";
    send_bounded_close(reader);
    reset_observation();
    return false;
  }

  set_active_generation(generation);
  bool allowed = false;
  std::string decision_reason;
  const bool decided = wait_for_decision(generation, allowed, decision_reason);
  clear_active_generation(generation);
  if (!decided || !allowed) {
    error = decision_reason.empty() ? "confirmation-denied" : decision_reason;
    send_bounded_close(reader);
    reset_observation();
    return false;
  }
  if (stop_.load(std::memory_order_acquire)) {
    error = "session-stopping";
    send_bounded_close(reader);
    reset_observation();
    return false;
  }

  // 确认后重新向同一 owner 检查完整绑定，并再次核验 OS 目标。
  NSDictionary* check = nil;
  std::string check_error;
  if (!reader.request(@"check", association_payload(binding), &check, check_error) ||
      !response_matches_binding(check, binding, check_error)) {
    error = "post-confirm-check: " + check_error;
    send_bounded_close(reader);
    reset_observation();
    return false;
  }
  if (!window_still_matches(binding.target, error)) {
    send_bounded_close(reader);
    reset_observation();
    return false;
  }
  std::string cancel_reason;
  if (poll_cancellation(cancel_reason)) {
    error = cancel_reason;
    send_bounded_close(reader);
    reset_observation();
    return false;
  }
  if (reader.has_buffered_bytes()) {
    // 不允许在切换 reader 所有权时丢失半帧 revoked 通知；无法证明干净边界就拒绝采集。
    error = "authority-reader-buffer-not-empty";
    send_bounded_close(reader);
    reset_observation();
    return false;
  }

  auto lease = std::make_unique<zody::cua::round11::MachineLease>();
  const zody::cua::round11::MachineLeaseResult lease_result = lease->acquire();
  if (!lease_result.acquired()) {
    error = lease_result.status == zody::cua::round11::MachineLeaseResult::Status::Busy
                ? "machine-busy"
                : "machine-lease-invalid";
    send_bounded_close(reader);
    reset_observation();
    return false;
  }

  const std::string file_name = capture_file_name();
  if (file_name.empty()) {
    lease->release();
    error = "capture-file-name-unavailable";
    send_bounded_close(reader);
    reset_observation();
    return false;
  }
  const std::string output_path = launch_.capture_root + "/" + file_name;

  zody::cua::round11::CaptureRequestContext context;
  context.ref = session_ref_dictionary(binding);
  context.trace_id = ns_string(binding.trace_id);
  context.producer_incarnation = ns_string(binding.producer_incarnation);
  context.run_id = ns_string(binding.run_id);
  context.turn_id = ns_string(binding.turn_id);
  context.output_path = ns_string(output_path);
  context.window_id = binding.target.window_id;
  context.pid = binding.target.pid;
  context.layer = binding.target.layer;
  context.x = binding.target.x;
  context.y = binding.target.y;
  context.width = binding.target.width;
  context.height = binding.target.height;

  // 中文原因：capture 文件名由 SecRandom 生成且 helper 用 O_EXCL 创建；创建前
  // unlink 会把“新名字冲突/竞态”变成删除一个本进程尚未持有的路径。
  const int authority_fd = connection.release();
  auto authority = std::make_unique<zody::cua::round11::AuthorityClient>(authority_fd);
  promote_active_authority(authority.get(), authority_fd);
  const zody::cua::round11::CaptureOutcome outcome =
      zody::cua::round11::capture_once(*authority, *lease, context);
  reset_observation();

  if (!outcome.resources_released) {
    // 中文原因：资源归还未知时既不能释放 lease，也不能关闭仍可能被 Swift 回调使用的
    // authority；这里释放 C++ owner 但故意泄漏原对象（含 fd/flock），直到进程退出。
    clear_active_connection();
    authority.release();
    lease.release();
    error = "fatal-resource-release-unknown";
    return false;
  }
  if (!outcome.ok) {
    clear_active_connection();
    lease->release();
    authority->close();
    error = outcome.reason.empty() ? "capture-failed" : outcome.reason;
    return false;
  }

  size_t png_bytes = 0;
  std::string verify_error;
  if (!verify_capture_file(launch_.capture_root, output_path, outcome.png_sha256,
                           outcome.width, outcome.height, png_bytes, verify_error)) {
    clear_active_connection();
    lease->release();
    authority->close();
    (void)unlink(output_path.c_str());
    error = "capture-file-verify: " + verify_error;
    return false;
  }

  lease->release();
  if (lease->held()) {
    clear_active_connection();
    authority->close();
    (void)unlink(output_path.c_str());
    error = "machine-lease-release-not-confirmed";
    return false;
  }

  if (stop_.load(std::memory_order_acquire)) {
    clear_active_connection();
    authority->close();
    (void)unlink(output_path.c_str());
    error = "session-stopping-before-final-check";
    return false;
  }

  // 最终 gate：同一 owner 仍为 candidate。失败时不提交 captureResult。
  NSDictionary* final_check = nil;
  std::string final_error;
  if (!authority->request(@"check", association_payload(binding), &final_check, final_error) ||
      !response_matches_binding(final_check, binding, final_error)) {
    clear_active_connection();
    authority->close();
    (void)unlink(output_path.c_str());
    error = "final-check: " + final_error;
    return false;
  }

  if (stop_.load(std::memory_order_acquire)) {
    // 最终 owner 检查通过后仍可能收到 stop；交付前再拒绝一次晚到结果。
    clear_active_connection();
    authority->close();
    (void)unlink(output_path.c_str());
    error = "session-stopping-before-capture-result";
    return false;
  }

  NSDictionary* capture_result = @{
    @"ref" : session_ref_dictionary(binding),
    @"traceId" : ns_string(binding.trace_id),
    @"producerIncarnation" : ns_string(binding.producer_incarnation),
    @"runId" : ns_string(binding.run_id),
    @"turnId" : ns_string(binding.turn_id),
    @"target" : @{
      @"pid" : @(binding.target.pid),
      @"windowId" : @(binding.target.window_id),
    },
    @"png" : @{
      @"path" : ns_string(output_path),
      @"sha256" : ns_string(outcome.png_sha256),
      @"width" : @(outcome.width),
      @"height" : @(outcome.height),
      @"bytes" : @(png_bytes),
    },
    @"resourcesReleased" : @YES,
    @"machineLeaseReleased" : @YES,
  };
  NSDictionary* ack = nil;
  std::string ack_error;
  if (!authority->request(@"captureResult", capture_result, &ack, ack_error)) {
    clear_active_connection();
    authority->close();
    (void)unlink(output_path.c_str());
    error = "capture-result: " + ack_error;
    return false;
  }
  if (!strict_capture_result_ack(ack)) {
    clear_active_connection();
    authority->close();
    (void)unlink(output_path.c_str());
    error = "capture-result-not-accepted";
    return false;
  }
  log_capture_delivered(outcome, png_bytes);
  clear_active_connection();
  (void)unlink(output_path.c_str());
  authority->close();
  return true;
}

}  // namespace zody::cua::desktop_session
