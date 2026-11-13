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
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <utility>

#include "authority_client.h"
#include "capture_owner.h"
#include "cua_desktop_session_pins.h"
#include "machine_lease.h"
#include "peer_auth.h"
#include "peer_socket.h"
#include "session_authority_fd.h"
#include "session_binding.h"
#include "session_capture_file.h"
#include "session_control.h"
#include "session_transport_auth.h"
#include "window_identity.h"

namespace zody::cua::desktop_session {
namespace {

constexpr size_t kAuthorityMaxLineBytes = 16 * 1024;
constexpr size_t kMetadataObservationMaxLineBytes = 128 * 1024;
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

AuthorityFdReader::AuthorityFdReader(int fd, std::string initial_buffer)
    : fd_(fd), buffer_(std::move(initial_buffer)) {}

bool AuthorityFdReader::send_frame(NSString* method, NSDictionary* payload,
                                   const std::string& request_id, std::string& error) {
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
  // 原因：有界 AX 结果与完整关联相加仍可能越界，必须约束整个 authority 帧。
  // 中文原因：仅已认证 bootstrap 指定元数据时允许结果帧扩容；其他请求及所有响应保持原上限。
  size_t limit = metadata_observation_ && [method isEqual:@"observationResult"]
    ? kMetadataObservationMaxLineBytes : kAuthorityMaxLineBytes;
  if (line.size() > limit) {
    error = "authority request exceeds frame bound";
    return false;
  }
  return send_all(fd_, line, error);
}

bool AuthorityFdReader::request(NSString* method, NSDictionary* payload, NSDictionary** result,
                                std::string& error) {
  if (result != nullptr) *result = nil;
  if (canceled_) {
    error = cancel_reason_;
    return false;
  }
  const std::string request_id = "native-" + std::to_string(next_request_++);
  if (!send_frame(method, payload, request_id, error)) return false;

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
    if (!bootstrap_seen_) {
      bootstrap_seen_ = true;
      id bootstrap = parsed[@"result"];
      id observation = [bootstrap isKindOfClass:[NSDictionary class]] ? bootstrap[@"observation"] : nil;
      id observation_method = [observation isKindOfClass:[NSDictionary class]] ? observation[@"method"] : nil;
      id ok = [bootstrap isKindOfClass:[NSDictionary class]] ? bootstrap[@"ok"] : nil;
      metadata_observation_ = [method isEqual:@"bootstrap"] && ok &&
        CFGetTypeID((__bridge CFTypeRef)ok) == CFBooleanGetTypeID() && [ok boolValue] &&
        [observation_method isKindOfClass:[NSString class]] &&
        ([observation_method isEqual:@"list_apps"] || [observation_method isEqual:@"list_windows"]);
    }
    if (result != nullptr) *result = parsed[@"result"];
    return true;
  }
}

bool AuthorityFdReader::send(NSString* method, NSDictionary* payload, std::string& request_id,
                             std::string& error) {
  request_id.clear();
  if (canceled_) {
    error = cancel_reason_;
    return false;
  }
  request_id = "native-" + std::to_string(next_request_++);
  if (!send_frame(method, payload, request_id, error)) {
    request_id.clear();
    return false;
  }
  return true;
}

AuthorityFdReader::AwaitFrame AuthorityFdReader::await_response(const std::string& request_id,
                                                                int timeout_ms) {
  AwaitFrame frame;
  if (canceled_) {
    frame.status = AwaitStatus::Canceled;
    frame.reason = cancel_reason_;
    return frame;
  }
  std::string response;
  std::string error;
  const ReadStatus status = read_line(timeout_ms, response, error);
  if (status == ReadStatus::Timeout) {
    frame.status = AwaitStatus::Timeout;
    return frame;
  }
  const auto cancel = [&](std::string reason) {
    canceled_ = true;
    cancel_reason_ = std::move(reason);
    frame.status = AwaitStatus::Canceled;
    frame.reason = cancel_reason_;
    return frame;
  };
  if (status == ReadStatus::Eof) return cancel("authority-eof");
  if (status == ReadStatus::Error)
    return cancel(error.empty() ? "authority-read-error" : error);
  NSDictionary* parsed = nil;
  if (!parse_object(response, &parsed, error)) return cancel(std::move(error));
  std::string method_name;
  const FieldStatus method_status = string_field(parsed, @"method", method_name);
  if (method_status == FieldStatus::Invalid) return cancel("invalid-authority-method-field");
  if (method_status == FieldStatus::Valid && method_name == "revoked")
    return cancel("owner-invalidated");
  std::string response_id;
  if (string_field(parsed, @"requestId", response_id) != FieldStatus::Valid ||
      response_id != request_id) {
    return cancel("unexpected-authority-frame");
  }
  frame.status = AwaitStatus::Response;
  frame.result = parsed[@"result"];
  return frame;
}

// 等待期间也必须持续处理 owner 失效/EOF；完整 line 被消费后返回 true。
bool AuthorityFdReader::pollCancel(int timeout_ms, std::string& reason) {
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

AuthorityFdReader::FieldStatus AuthorityFdReader::string_field(NSDictionary* frame, NSString* key,
                                                               std::string& out) {
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

bool AuthorityFdReader::parse_object(const std::string& line, NSDictionary** frame,
                                     std::string& error) {
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

AuthorityFdReader::ReadStatus AuthorityFdReader::read_line(int timeout_ms, std::string& line,
                                                           std::string& error) {
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

// 中文原因：ownerName/windowName 来自 OS 窗口事实并最终展示在 App 弹窗里。只过滤
// 控制字符（C0 与 DEL），保留完整 UTF-8（中文标题不再变成 '?'），否则用户无法核对
// 截图目标；引号/反斜杠由 JSON 序列化转义，不再替换。按 UTF-8 字节 cap 128，且
// 截断只落在完整码点边界上——切半个字符会让 NSString UTF-8 初始化返回 nil。
std::string sanitize_display_name(const std::string& value) {
  std::string safe;
  safe.reserve(value.size() < 128 ? value.size() : 128);
  for (size_t index = 0; index < value.size();) {
    const unsigned char byte = static_cast<unsigned char>(value[index]);
    if (byte < 0x20 || byte == 0x7f) {
      ++index;
      continue;
    }
    size_t sequence = 1;
    if ((byte & 0xe0) == 0xc0) {
      sequence = 2;
    } else if ((byte & 0xf0) == 0xe0) {
      sequence = 3;
    } else if ((byte & 0xf8) == 0xf0) {
      sequence = 4;
    }
    // 只接受完整且合法的多字节序列；残缺时按单字节处理，避免越界读取。
    bool valid = index + sequence <= value.size();
    for (size_t offset = 1; valid && offset < sequence; ++offset) {
      if ((static_cast<unsigned char>(value[index + offset]) & 0xc0) != 0x80) valid = false;
    }
    if (!valid) sequence = 1;
    if (safe.size() + sequence > 128) break;
    safe.append(value, index, sequence);
    index += sequence;
  }
  return safe;
}

// confirm 帧 payload：generation + 与 check 帧同源同字段的完整关联 + target 展示事实。
NSDictionary* confirm_payload(uint64_t generation, const SessionBinding& binding) {
  return @{
    @"generation" : @(generation),
    @"ref" : session_ref_dictionary(binding),
    @"traceId" : ns_string(binding.trace_id),
    @"producerIncarnation" : ns_string(binding.producer_incarnation),
    @"runId" : ns_string(binding.run_id),
    @"turnId" : ns_string(binding.turn_id),
    @"target" : @{
      @"pid" : @(binding.target.pid),
      @"windowId" : @(binding.target.window_id),
      @"layer" : @(binding.target.layer),
      @"x" : @(binding.target.x),
      @"y" : @(binding.target.y),
      @"width" : @(binding.target.width),
      @"height" : @(binding.target.height),
      @"ownerName" : ns_string(sanitize_display_name(binding.target.owner_name)),
      @"windowName" : ns_string(sanitize_display_name(binding.target.window_name)),
    },
  };
}

bool strict_bool_value(id value, bool expected) {
  return value != nil && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID() &&
         [value boolValue] == expected;
}

// CLI confirm 响应 result 三类：{ok:true,allowed:true} / {ok:true,allowed:false} /
// {ok:false,...}。ok/allowed 必须是精确 JSON bool：boolValue 会把字符串/数字等非布尔
// JSON 也当真，这里一律 fail-closed，防止畸形响应被宽松解释成允许。
AppConfirmResult classify_app_confirm_result(NSDictionary* result) {
  const AppConfirmResult failed{AppConfirmStatus::Failed, "app-confirm-failed"};
  if (![result isKindOfClass:[NSDictionary class]]) return failed;
  if (!strict_bool_value(result[@"ok"], true) && !strict_bool_value(result[@"ok"], false)) {
    return failed;
  }
  if (!strict_bool_value(result[@"ok"], true)) return failed;
  if (strict_bool_value(result[@"allowed"], true)) {
    return {AppConfirmStatus::Allowed, "user-approved"};
  }
  if (strict_bool_value(result[@"allowed"], false)) {
    return {AppConfirmStatus::Denied, "user-canceled"};
  }
  return failed;
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
  // 中文原因：App 内确认链路失败（CLI confirm 返回 ok:false 的四个固定 reason 与
  // 本地 app-confirm-failed）语义上是“确认不可用/无法完成”，不是用户明确拒绝，
  // 归入 confirmation-unavailable 固定桶；用户拒绝仍是 allowed:false 走 user-canceled
  // → confirmation-denied，两者分账。放在 confirmation-invalidated 之后，避免
  // "confirmation-invalidated" 被更短前缀 "confirmation-invalid" 遮蔽改变原桶。
  if (starts("app-confirm-failed") || starts("confirmation-failed") ||
      starts("confirmation-invalid") || starts("confirmation-duplicate"))
    return "confirmation-unavailable";
  if (starts("confirmation-canceled")) return "confirmation-canceled";
  if (starts("peer-auth:")) return "peer-auth-failed";
  if (error == "peer-pid-mismatch") return "peer-pid-mismatch";
  if (starts("node-loaded-code:")) return "node-loaded-code-mismatch";
  if (starts("authority-transport")) return "authority-transport-failed";
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
  if (error == "authority-fd-blocking-failed") return "authority-fd-mode-failed";
  // 中文原因：capture_once 的失败 reason 本身已是固定枚举；折叠成 capture-failed
  // 会丢失 TCC/visual/context 等真实阶段，无法定位失败。这里只保留已知固定值，
  // 动态 write 错误按阶段归类，未知值仍落到有界泛化 reason。
  if (error == "machine-lease-not-held") return "machine-lease-not-held";
  if (error == "capture-context-incomplete") return "capture-context-incomplete";
  if (error == "tcc-not-authorized") return "tcc-not-authorized";
  if (error == "visual-start-denied") return "visual-start-denied";
  if (error == "visual-take-png-failed") return "visual-take-png-failed";
  if (error == "visual-png-invalid") return "visual-png-invalid";
  if (error == "visual-wait-failed") return "visual-wait-failed";
  if (error == "visual-resources-not-released") return "visual-resources-not-released";
  if (error == "visual-destroy-pending") return "visual-destroy-pending";
  if (error == "visual-staticlib-missing") return "visual-staticlib-missing";
  if (error == "capture-facts-missing") return "capture-facts-missing";
  if (error == "authority-revoke-failed") return "authority-revoke-failed";
  if (error == "authority-revoke-not-confirmed") return "authority-revoke-not-confirmed";
  if (starts("cannot create PNG:")) return "capture-create-failed";
  if (starts("cannot write PNG:")) return "capture-write-failed";
  if (starts("cannot fsync PNG:")) return "capture-fsync-failed";
  if (starts("capture-failed")) return "capture-failed";
  if (starts("visual-")) return "visual-failed";
  if (starts("tcc-")) return "tcc-failed";
  if (starts("capture-context")) return "capture-context-failed";
  if (starts("authority-revoke")) return "authority-revoke-failed";
  if (starts("write-")) return "capture-write-failed";
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

// 固定、有界的 lease 事件：只表达实际 acquire / release 事实，不输出 code/body/路径。
void log_machine_lease_acquired() {
  std::fputs("[cua-native] machine-lease-acquired\n", stderr);
  std::fflush(stderr);
}

void log_machine_lease_released(bool confirmed) {
  std::fprintf(stderr, "[cua-native] machine-lease-released {\"confirmed\":%s}\n",
               confirmed ? "true" : "false");
  std::fflush(stderr);
}

// 所有实际 release 路径都走这里，让 Stop 验收看到真实 held() 结果，而不是只记录
// 正常成功路径或用空 true 代表释放。
bool release_machine_lease_logged(zody::cua::round11::MachineLease& lease) {
  lease.release();
  const bool confirmed = !lease.held();
  log_machine_lease_released(confirmed);
  return confirmed;
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

bool SessionSupervisor::poll_control_cancellation(std::string& reason) {
  if (control_ == nullptr) return false;
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

bool SessionSupervisor::poll_cancellation(std::string& reason) {
  if (stop_.load(std::memory_order_acquire)) {
    std::lock_guard<std::mutex> lock(stop_mutex_);
    reason = stop_reason_;
    return true;
  }
  if (authority_reader_ != nullptr && authority_reader_->pollCancel(0, reason)) return true;
  return poll_control_cancellation(reason);
}

// 中文原因：confirm 等待期间 authority fd 的 EOF/revoked 由等待循环的
// await_response 自己读取；这里的取消轮询只观察 stop_ 与 entry control fd。
// 否则 pollCancel(0) 会抢先消费刚到达的 confirm 响应帧并误判为
// unexpected-authority-frame，把用户允许错杀成取消。
bool SessionSupervisor::poll_confirmation_cancellation(std::string& reason) {
  if (stop_.load(std::memory_order_acquire)) {
    std::lock_guard<std::mutex> lock(stop_mutex_);
    reason = stop_reason_;
    return true;
  }
  return poll_control_cancellation(reason);
}

AppConfirmResult request_app_confirmation(AuthorityFdReader& reader, uint64_t generation,
                                          const SessionBinding& binding,
                                          const AppConfirmCancelPoll& poll_cancel) {
  std::string request_id;
  std::string send_error;
  if (!reader.send(@"confirm", confirm_payload(generation, binding), request_id, send_error)) {
    // 中文原因：confirm 帧发不出去时本次确认链路已无法完成，与 CLI ok:false 同一
    // fail-closed 出口；写失败的动态细节只进 capture-rejected 固定桶，不进
    // confirmation marker。
    return {AppConfirmStatus::Failed, "app-confirm-failed"};
  }
  // 无固定 deadline：由响应、连接终止或取消源收口；不得沿用 kAuthorityIoTimeoutMs。
  while (true) {
    std::string cancel_reason;
    if (poll_cancel && poll_cancel(cancel_reason)) {
      return {AppConfirmStatus::Canceled, cancel_reason};
    }
    const AuthorityFdReader::AwaitFrame frame = reader.await_response(request_id, 250);
    switch (frame.status) {
      case AuthorityFdReader::AwaitStatus::Response:
        return classify_app_confirm_result(frame.result);
      case AuthorityFdReader::AwaitStatus::Canceled:
        return {AppConfirmStatus::Canceled, frame.reason};
      case AuthorityFdReader::AwaitStatus::Timeout:
        break;
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

  // 中文原因：path/同 UID/0700 不能证明连接来自真实 Helper。必须在创建
  // AuthorityFdReader、发送 bootstrap 或任何 wire session/owner 数据之前完成
  // fresh challenge + role=authority HMAC proof；同包多读的字节保留给原协议。
  std::string transport_remainder;
  if (!perform_authority_transport_auth(fd, launch_.transport_authentication_key,
                                        kAuthorityIoTimeoutMs, stop_, transport_remainder,
                                        error)) {
    if (error.rfind("authority-transport", 0) != 0) {
      error = "authority-transport:" + error;
    }
    return false;
  }

  AuthorityFdReader reader(fd, std::move(transport_remainder));
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
  // 原因：AX 观察必须使用独立读取确认，不能伪造截图 target 或继承截图授权。
  if ([bootstrap isKindOfClass:[NSDictionary class]] && bootstrap[@"observation"] != nil) {
    const ObserverExchange exchange = [&](NSString* method, NSDictionary* payload, std::string& failure) -> NSDictionary* {
      if (![method isEqual:@"confirmRead"]) {
        NSDictionary* response = nil;
        return reader.request(method, payload, &response, failure) ? response : nil;
      }
      // 读取确认与截图确认一样无固定人类响应时限；Stop/EOF 负责收口。
      std::string request_id;
      if (!reader.send(method, payload, request_id, failure)) return nil;
      while (true) {
        if (poll_confirmation_cancellation(failure)) return nil;
        const auto response = reader.await_response(request_id, 250);
        if (response.status == AuthorityFdReader::AwaitStatus::Response) return response.result;
        if (response.status == AuthorityFdReader::AwaitStatus::Canceled) { failure = response.reason; return nil; }
      }
    };
    const bool observed = observer_.run(bootstrap, launch_.producer_incarnation, exchange,
      [this](std::string& reason) { return poll_cancellation(reason); }, confirmation_, error);
    reset_observation();
    return observed;
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
    // 停止/失效已锁存时不得再发起 App 确认；否则 stop 后仍会向 App 弹出待确认窗口。
    error = "session-stopping-before-confirmation";
    send_bounded_close(reader);
    reset_observation();
    return false;
  }

  // App 内确认：登记 prompt 后经 authority 双工帧请求 App 决定。AppKit 窗口已由
  // App 侧 PermissionDialog 呈现，这里不再有原生 NSAlert，也不再要求主线程。
  const uint64_t generation = confirmation_.begin(binding);
  if (generation == 0) {
    error = "confirmation-unavailable-or-busy";
    send_bounded_close(reader);
    reset_observation();
    return false;
  }

  set_active_generation(generation);
  bool allowed = false;
  std::string decision_reason;
  {
    // 等待循环无固定 deadline；取消源只观察 stop_ 与 control fd，authority fd 的
    // EOF/revoked 由循环内的 await_response 读取。
    const AppConfirmResult app = request_app_confirmation(
        reader, generation, binding,
        [this](std::string& reason) { return poll_confirmation_cancellation(reason); });
    switch (app.status) {
      case AppConfirmStatus::Allowed:
        // 中文原因：ConfirmationState 是唯一判定 owner。App 返回允许后仍可能有并发
        // invalidate（Stop/owner 撤销）先一步锁存；只有 resolveFromApp 真正接受时
        // 才放行 lease/capture，否则一律 fail-closed。
        allowed = confirmation_.resolveFromApp(generation, true);
        decision_reason = allowed ? "user-approved" : "confirmation-stale";
        break;
      case AppConfirmStatus::Denied:
        // 拒绝永远不放行；返回值只表达 state machine 是否接受，不改变拒绝语义。
        (void)confirmation_.resolveFromApp(generation, false);
        allowed = false;
        decision_reason = "user-canceled";
        break;
      case AppConfirmStatus::Failed:
        confirmation_.resolveAppConfirmFailed(generation);
        decision_reason = "app-confirm-failed";
        break;
      case AppConfirmStatus::Canceled:
        // stop/失效可能已通过 requestStop 先 invalidate；late 调用无副作用。
        confirmation_.invalidate(generation, app.reason);
        decision_reason = app.reason;
        break;
    }
  }
  clear_active_generation(generation);
  if (!allowed) {
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
  log_machine_lease_acquired();

  const std::string file_name = capture_file_name();
  if (file_name.empty()) {
    (void)release_machine_lease_logged(*lease);
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

  std::string handoff_error;
  if (!make_authority_fd_blocking(connection.get(), handoff_error)) {
    // 中文原因：R11 AuthorityClient 的 reader_loop 使用阻塞 recv，看到 EAGAIN
    // 会按读错误关闭；accepted fd 仍是 O_NONBLOCK 时首次 checkpoint 会误失败。
    (void)release_machine_lease_logged(*lease);
    send_bounded_close(reader);
    reset_observation();
    error = "authority-fd-blocking-failed";
    return false;
  }

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
    (void)release_machine_lease_logged(*lease);
    authority->close();
    error = outcome.reason.empty() ? "capture-failed" : outcome.reason;
    return false;
  }

  size_t png_bytes = 0;
  std::string verify_error;
  if (!verify_capture_file(launch_.capture_root, output_path, outcome.png_sha256,
                           outcome.width, outcome.height, png_bytes, verify_error)) {
    clear_active_connection();
    (void)release_machine_lease_logged(*lease);
    authority->close();
    (void)unlink(output_path.c_str());
    error = "capture-file-verify: " + verify_error;
    return false;
  }

  if (!release_machine_lease_logged(*lease)) {
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
