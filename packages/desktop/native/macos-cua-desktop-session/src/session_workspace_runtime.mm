#include "session_workspace_runtime.h"

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <dispatch/dispatch.h>

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "bundle_paths.h"
#include "cua_desktop_session_pins.h"
#include "peer_auth.h"
#include "peer_socket.h"
#include "r11_self_identity.h"
#include "session_workspace_handoff.h"

namespace zody::cua::desktop_session {
namespace {

constexpr int kWorkspaceWaitMs = 250;
constexpr int kWorkspaceAcceptTimeoutMs = 20'000;
constexpr int kWorkspaceLaunchTimeoutMs = 30'000;
constexpr int kWorkspaceMaxStatusBytes = 4 * 1024;

volatile sig_atomic_t g_relay_signal = 0;
pid_t g_relay_parent = 0;

void relay_signal_handler(int) { g_relay_signal = 1; }

// 中文原因：relay 日志只保留固定 pid/role/stage，不写 env/cwd/nonce/用户数据。
void relay_log(const char* stage) {
  std::fprintf(stderr, "[cua-native] workspace-relay stage=%s pid=%d\n", stage,
               static_cast<int>(getpid()));
}

void child_log(const char* stage) {
  std::fprintf(stderr, "[cua-native] workspace-child stage=%s pid=%d\n", stage,
               static_cast<int>(getpid()));
}

// 中文原因：launch 失败只保留固定 NSError domain/code，不写 localizedDescription、
// userInfo 或任何路径；domain 也收紧到有界安全字符集，避免把系统文本透传到日志。
std::string bounded_launch_domain(NSString* domain) {
  if (domain == nil) return "unknown";
  const char* utf8 = [domain UTF8String];
  if (utf8 == nullptr) return "unknown";
  const std::string raw = utf8;
  std::string out;
  for (char value : raw) {
    if (out.size() >= 64) break;
    const bool safe = (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
                      (value >= '0' && value <= '9') || value == '.' || value == '-' ||
                      value == '_';
    out.push_back(safe ? value : '?');
  }
  return out.empty() ? "unknown" : out;
}

bool relay_parent_alive() {
  if (g_relay_parent <= 1) return true;
  return getppid() == g_relay_parent;
}

NSString* ns_utf8(const std::string& value) {
  return [NSString stringWithUTF8String:value.c_str()];
}

std::string cf_data_hex(CFDataRef data) {
  const UInt8* bytes = CFDataGetBytePtr(data);
  const CFIndex length = CFDataGetLength(data);
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.reserve(static_cast<size_t>(length) * 2);
  for (CFIndex index = 0; index < length; ++index) {
    out.push_back(hex[(bytes[index] >> 4) & 0x0f]);
    out.push_back(hex[bytes[index] & 0x0f]);
  }
  return out;
}

bool read_cdhash_from_code(SecCodeRef code, std::string& cdhash, std::string& error) {
  CFDictionaryRef information = nullptr;
  const OSStatus status =
      SecCodeCopySigningInformation(code, kSecCSSigningInformation, &information);
  if (status != errSecSuccess || information == nullptr) {
    error = "signing information is unavailable";
    return false;
  }
  CFTypeRef unique = CFDictionaryGetValue(information, kSecCodeInfoUnique);
  if (unique == nullptr || CFGetTypeID(unique) != CFDataGetTypeID()) {
    CFRelease(information);
    error = "signing information has no cdhash";
    return false;
  }
  cdhash = cf_data_hex(static_cast<CFDataRef>(unique));
  CFRelease(information);
  if (cdhash.empty()) {
    error = "signing information has an empty cdhash";
    return false;
  }
  return true;
}

// 中文原因：child 也必须先过完整 self preflight（固定 bundle/leaf/DR、HR、空
// entitlements），不能只靠空 expected-cdhash 的 partial loaded 字段判断。
bool self_preflight_ok(std::string& error) {
  zody::cua::round11::PinnedIdentity pinned;
  pinned.bundle_id = CUA_DESKTOP_SESSION_SELF_IDENTIFIER;
  pinned.leaf_certificate_sha256 = CUA_DESKTOP_SESSION_SELF_LEAF_SHA256;
  pinned.designated_requirement = CUA_DESKTOP_SESSION_SELF_DESIGNATED_REQUIREMENT;
  pinned.configured = !pinned.bundle_id.empty() && !pinned.leaf_certificate_sha256.empty() &&
                      !pinned.designated_requirement.empty();
  const zody::cua::round11::SelfPreflight preflight =
      zody::cua::round11::evaluate_self_preflight(pinned);
  if (!preflight.ok) {
    error = preflight.reason.empty() ? "self-preflight-failed" : preflight.reason;
    return false;
  }
  return true;
}

std::string current_self_cdhash(std::string& error) {
  if (!self_preflight_ok(error)) return "";
  SecCodeRef code = nullptr;
  const OSStatus status = SecCodeCopySelf(kSecCSDefaultFlags, &code);
  if (status != errSecSuccess || code == nullptr) {
    error = "cannot read self code";
    return "";
  }
  std::string cdhash;
  const bool ok = read_cdhash_from_code(code, cdhash, error);
  CFRelease(code);
  return ok ? cdhash : "";
}

// 中文原因：same-CDHash 必须来自与 peer_auth 相同的 LOCAL_PEERTOKEN audit token；
// 按 PID 再查是另一次快照。这里用同一 token 创建 SecCode guest 读取
// kSecCodeInfoUnique，避免 PID 复用/二次快照差异。
bool audit_token_cdhash(const audit_token_t& token, std::string& cdhash, std::string& error) {
  CFDataRef token_data = CFDataCreate(kCFAllocatorDefault,
                                      reinterpret_cast<const UInt8*>(&token), sizeof(token));
  if (token_data == nullptr) {
    error = "cannot encode peer audit token";
    return false;
  }
  const void* keys[] = {kSecGuestAttributeAudit};
  const void* values[] = {token_data};
  CFDictionaryRef attributes =
      CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1,
                         &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFRelease(token_data);
  if (attributes == nullptr) {
    error = "cannot build peer audit attributes";
    return false;
  }
  SecCodeRef code = nullptr;
  const OSStatus status =
      SecCodeCopyGuestWithAttributes(nullptr, attributes, kSecCSDefaultFlags, &code);
  CFRelease(attributes);
  if (status != errSecSuccess || code == nullptr) {
    error = "cannot resolve peer audit token";
    return false;
  }
  const bool ok = read_cdhash_from_code(code, cdhash, error);
  CFRelease(code);
  return ok;
}

// 认证 peer：LOCAL_PEERTOKEN audit token + 固定 bundle/leaf/DR + HR + 空 entitlements，
// 再要求 peer 实际加载字节与当前 self CDHash 一致（不是 argv/env 自报）。
bool authenticate_workspace_peer(int fd, pid_t required_pid, std::string& error) {
  PeerToken token;
  if (!read_peer_token(fd, token, error)) return false;
  if (required_pid > 0 && token.pid != required_pid) {
    error = "workspace peer pid does not match the launched application";
    return false;
  }
  // 中文原因：不能把 token.euid 和自己比较（恒等）。用当前 geteuid 做显式约束，
  // 同 uid 之外一律拒绝。
  const uid_t expected_uid = geteuid();
  if (token.euid != expected_uid) {
    error = "workspace peer uid does not match the current effective uid";
    return false;
  }
  zody::cua::round11::PeerExpectation expectation;
  expectation.pid = token.pid;
  expectation.uid = expected_uid;
  expectation.bundle_id = CUA_DESKTOP_SESSION_SELF_IDENTIFIER;
  expectation.leaf_certificate_sha256 = CUA_DESKTOP_SESSION_SELF_LEAF_SHA256;
  expectation.designated_requirement = CUA_DESKTOP_SESSION_SELF_DESIGNATED_REQUIREMENT;
  expectation.require_empty_entitlements = true;
  const zody::cua::round11::PeerAuthResult auth =
      zody::cua::round11::authenticate_peer_fd(fd, expectation);
  if (!auth.ok) {
    error = "workspace peer authentication failed: " + auth.reason;
    return false;
  }
  const std::string self_cdhash = current_self_cdhash(error);
  if (self_cdhash.empty()) return false;
  std::string peer_cdhash;
  if (!audit_token_cdhash(token.token, peer_cdhash, error)) return false;
  if (peer_cdhash != self_cdhash) {
    error = "workspace peer cdhash does not match the current self";
    return false;
  }
  return true;
}

std::string make_rendezvous_dir(std::string& error) {
  char pattern[] = "/tmp/cua-ws.XXXXXX";
  char* created = mkdtemp(pattern);
  if (created == nullptr) {
    error = std::string("cannot create rendezvous dir: ") + std::strerror(errno);
    return "";
  }
  const std::string dir = created;
  if (chmod(dir.c_str(), 0700) != 0) {
    error = std::string("cannot restrict rendezvous dir: ") + std::strerror(errno);
    (void)rmdir(dir.c_str());
    return "";
  }
  if (!validate_private_workdir(dir, error)) {
    (void)rmdir(dir.c_str());
    return "";
  }
  return dir;
}

bool launch_workspace_child_app(const std::string& bundle_path, NSArray<NSString*>* arguments,
                                NSRunningApplication* __strong* launched_app, pid_t& child_pid,
                                std::string& error) {
  child_pid = -1;
  if (launched_app != nullptr) *launched_app = nil;
  NSURL* bundle_url = [NSURL fileURLWithPath:ns_utf8(bundle_path)];
  if (bundle_url == nil) {
    error = "workspace bundle url is invalid";
    return false;
  }
  NSWorkspaceOpenConfiguration* configuration = [NSWorkspaceOpenConfiguration configuration];
  // 中文原因：createsNewApplicationInstance 之外再显式禁止 app 实例替换，避免
  // LaunchServices 把请求解析到别的已运行实例导致 real PID 与认证对象不一致。
  configuration.createsNewApplicationInstance = YES;
  configuration.allowsRunningApplicationSubstitution = NO;
  configuration.activates = NO;
  configuration.addsToRecentItems = NO;
  configuration.arguments = arguments;
  __block NSRunningApplication* launched = nil;
  __block NSError* launch_error = nil;
  __block BOOL finished = NO;
  [[NSWorkspace sharedWorkspace] openApplicationAtURL:bundle_url
                                        configuration:configuration
                                    completionHandler:^(NSRunningApplication* application,
                                                        NSError* completion_error) {
                                      // 中文原因：completion 不保证在 main queue；统一
                                      // dispatch 回 main，由同一主线程 run loop 赋值/读取，
                                      // 避免 __block 变量跨线程无同步访问。
                                      dispatch_async(dispatch_get_main_queue(), ^{
                                        launched = application;
                                        launch_error = completion_error;
                                        finished = YES;
                                      });
                                    }];
  const auto deadline = std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(kWorkspaceLaunchTimeoutMs);
  while (!finished) {
    if (g_relay_signal != 0) {
      error = "workspace launch interrupted by signal";
      return false;
    }
    if (!relay_parent_alive()) {
      error = "workspace launch interrupted by parent exit";
      return false;
    }
    if (std::chrono::steady_clock::now() >= deadline) {
      error = "workspace launch timed out";
      return false;
    }
    // 中文原因：启动阶段不能阻塞主循环，否则既拿不到 real PID 也无法在上游退出时
    // 及时清理；main queue 由主线程 run loop 驱动。
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                             beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  }
  if (launch_error != nil || launched == nil) {
    if (launch_error != nil) {
      error = "workspace launch failed domain=" + bounded_launch_domain(launch_error.domain) +
              " code=" + std::to_string(static_cast<long>(launch_error.code));
    } else {
      error = "workspace launch returned no application";
    }
    return false;
  }
  child_pid = launched.processIdentifier;
  if (child_pid <= 0 || child_pid == static_cast<pid_t>(getpid())) {
    error = "workspace launch returned no application pid";
    return false;
  }
  if (launched_app != nullptr) *launched_app = launched;
  return true;
}

int accept_workspace_peer(int listener, int timeout_ms, std::string& error) {
  struct pollfd descriptor {};
  descriptor.fd = listener;
  descriptor.events = POLLIN;
  int ready = 0;
  do {
    ready = poll(&descriptor, 1, timeout_ms);
  } while (ready < 0 && errno == EINTR);
  if (ready < 0) {
    error = std::string("workspace accept poll failed: ") + std::strerror(errno);
    return -1;
  }
  if (ready == 0) return -2;
  if ((descriptor.revents & (POLLIN | POLLHUP | POLLERR)) == 0) {
    error = "workspace accept poll returned an unexpected state";
    return -1;
  }
  const int accepted = accept(listener, nullptr, nullptr);
  if (accepted < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return -2;
    error = std::string("workspace accept failed: ") + std::strerror(errno);
    return -1;
  }
  const int flags = fcntl(accepted, F_GETFL, 0);
  if (flags < 0 || fcntl(accepted, F_SETFL, flags | O_NONBLOCK) != 0 ||
      fcntl(accepted, F_SETFD, FD_CLOEXEC) != 0) {
    error = std::string("cannot configure workspace peer fd: ") + std::strerror(errno);
    close(accepted);
    return -1;
  }
  return accepted;
}

bool send_all_fd(int fd, const std::string& bytes, std::string& error) {
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t sent = send(fd, bytes.data() + offset, bytes.size() - offset, MSG_NOSIGNAL);
    if (sent < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        struct pollfd descriptor {};
        descriptor.fd = fd;
        descriptor.events = POLLOUT;
        int ready = 0;
        do {
          ready = poll(&descriptor, 1, kWorkspaceWaitMs);
        } while (ready < 0 && errno == EINTR);
        if (ready > 0) continue;
        error = "workspace status write timed out";
        return false;
      }
      error = std::string("workspace status write failed: ") + std::strerror(errno);
      return false;
    }
    if (sent == 0) {
      error = "workspace status write made no progress";
      return false;
    }
    offset += static_cast<size_t>(sent);
  }
  return true;
}

enum class StatusRead { Line, Timeout, Closed, Error };

StatusRead read_status_line(int fd, std::string& buffer, std::string& line, std::string& error) {
  const size_t newline = buffer.find('\n');
  if (newline != std::string::npos) {
    line = buffer.substr(0, newline);
    buffer.erase(0, newline + 1);
    return StatusRead::Line;
  }
  struct pollfd descriptor {};
  descriptor.fd = fd;
  descriptor.events = POLLIN;
  int ready = 0;
  do {
    ready = poll(&descriptor, 1, kWorkspaceWaitMs);
  } while (ready < 0 && errno == EINTR);
  if (ready < 0) {
    error = std::string("workspace status poll failed: ") + std::strerror(errno);
    return StatusRead::Error;
  }
  if (ready == 0) return StatusRead::Timeout;
  char chunk[1024];
  while (true) {
    const ssize_t received = recv(fd, chunk, sizeof(chunk), 0);
    if (received < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) return StatusRead::Timeout;
      error = std::string("workspace status read failed: ") + std::strerror(errno);
      return StatusRead::Error;
    }
    if (received == 0) return StatusRead::Closed;
    buffer.append(chunk, static_cast<size_t>(received));
    if (buffer.size() > kWorkspaceMaxStatusBytes) {
      error = "workspace status frame exceeds the bound";
      return StatusRead::Error;
    }
    const size_t found = buffer.find('\n');
    if (found != std::string::npos) {
      line = buffer.substr(0, found);
      buffer.erase(0, found + 1);
      return StatusRead::Line;
    }
    break;
  }
  return StatusRead::Timeout;
}

void pump_run_loop_briefly() {
  [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                           beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
}

void terminate_workspace_child(NSRunningApplication* application, int connection_fd) {
  // 中文原因：不能先发 NSRunningApplication terminate（Quit 会直接让 NSApp 退出，
  // 可能跳过 supervisor 清理）。先对已有连接 shutdown(SHUT_RDWR)，让 child 走既有
  // liveness EOF -> requestStop；preaccept 则让它走既有 5s connect timeout。
  if (connection_fd >= 0) (void)shutdown(connection_fd, SHUT_RDWR);
  if (application == nil || application.terminated) return;
  // 只按同一 NSWorkspace app 实例观察真实退出，避免裸 pid kill 的 PID 复用误杀。
  for (int attempt = 0; attempt < 140 && !application.terminated; ++attempt) {
    pump_run_loop_briefly();
    usleep(50'000);
  }
  if (!application.terminated) {
    // 仍未退出：只能强制终止；调用方保持失败/未证实清理语义，不宣称成功。
    (void)[application forceTerminate];
    for (int attempt = 0; attempt < 40 && !application.terminated; ++attempt) {
      pump_run_loop_briefly();
      usleep(50'000);
    }
  }
}

bool relay_send_handoff(int fd, const WorkspaceContext& context, const std::vector<int>& fds,
                        std::string& error) {
  const std::string context_json = workspace_context_json(context);
  if (context_json.empty()) {
    error = "workspace context serialization failed";
    return false;
  }
  // 中文原因：context(<=64KiB) 用有界长度帧，bridge fd 单独用 SCM_RIGHTS 发送；
  // 接收侧先精确读满 context，再 recvmsg 取 marker+fd，不能假定同一 read 收全两者。
  if (!write_bounded_frame(fd, context_json, 5'000, error)) return false;
  return workspace_send_fds(fd, fds, kWorkspaceFdMarker, error);
}

void close_relay_originals(const WorkspaceRelayOptions& options) {
  if (options.host_bridge_fd >= 0) (void)close(options.host_bridge_fd);
  if (options.cli_input_fd >= 0) (void)close(options.cli_input_fd);
  if (options.cli_output_fd >= 0) (void)close(options.cli_output_fd);
  // 中文原因：relay 不能继续持有真实 stdio 写端，否则 Node/child 结束后上层管道
  // 永不见 EOF。诊断日志在交接前已按固定字段写出，交接后只用退出码传播事实。
  (void)close(STDIN_FILENO);
  (void)close(STDOUT_FILENO);
  (void)close(STDERR_FILENO);
}

}  // namespace

int run_workspace_relay(const WorkspaceRelayOptions& options) {
  relay_log("start");
  g_relay_parent = getppid();

  zody::cua::round11::PinnedIdentity pinned;
  pinned.bundle_id = CUA_DESKTOP_SESSION_SELF_IDENTIFIER;
  pinned.leaf_certificate_sha256 = CUA_DESKTOP_SESSION_SELF_LEAF_SHA256;
  pinned.designated_requirement = CUA_DESKTOP_SESSION_SELF_DESIGNATED_REQUIREMENT;
  pinned.configured = !pinned.bundle_id.empty() && !pinned.leaf_certificate_sha256.empty() &&
                      !pinned.designated_requirement.empty();
  const zody::cua::round11::SelfPreflight self =
      zody::cua::round11::evaluate_self_preflight(pinned);
  if (!self.ok) {
    relay_log("self-preflight-refused");
    return 2;
  }

  std::string error;
  zody::cua::round11::BundlePaths paths;
  if (!zody::cua::round11::resolve_bundle_paths(paths, error)) {
    relay_log("bundle-path-refused");
    return 2;
  }
  const size_t contents_slash = paths.contents.find_last_of('/');
  if (contents_slash == std::string::npos || contents_slash == 0) {
    relay_log("bundle-path-refused");
    return 2;
  }
  const std::string bundle_path = paths.contents.substr(0, contents_slash);

  std::vector<int> source_fds;
  if (!workspace_bridge_fds_for_entry(options.entry_name, options.host_bridge_fd,
                                      options.cli_input_fd, options.cli_output_fd, source_fds,
                                      error)) {
    relay_log("bridge-plan-refused");
    return 2;
  }

  WorkspaceContext context;
  context.entry_name = options.entry_name;
  context.nonce = workspace_nonce();
  context.fd_count = source_fds.size();
  char cwd_buffer[4096] = {0};
  if (!workspace_nonce_valid(context.nonce) || getcwd(cwd_buffer, sizeof(cwd_buffer)) == nullptr) {
    relay_log("context-refused");
    return 2;
  }
  context.cwd = cwd_buffer;
  if (!workspace_collect_environment(context.env, error)) {
    relay_log("environment-refused");
    return 2;
  }

  const std::string rendezvous_dir = make_rendezvous_dir(error);
  if (rendezvous_dir.empty()) {
    relay_log("rendezvous-refused");
    return 2;
  }
  const std::string socket_path = peer_socket_path(rendezvous_dir);
  int listener = -1;
  SocketOwnership ownership;
  if (!create_private_listener(socket_path, listener, ownership, error)) {
    relay_log("listener-refused");
    (void)rmdir(rendezvous_dir.c_str());
    return 2;
  }
  (void)fcntl(listener, F_SETFD, FD_CLOEXEC);

  struct sigaction action {};
  action.sa_handler = relay_signal_handler;
  sigemptyset(&action.sa_mask);
  action.sa_flags = 0;
  (void)sigaction(SIGTERM, &action, nullptr);
  (void)sigaction(SIGINT, &action, nullptr);
  (void)sigaction(SIGHUP, &action, nullptr);

  NSArray<NSString*>* arguments = @[
    @"--workspace-child",
    @"--entry-name",
    ns_utf8(options.entry_name),
    @"--workspace-rendezvous",
    ns_utf8(socket_path),
    @"--workspace-nonce",
    ns_utf8(context.nonce),
  ];
  NSRunningApplication* __strong child_app = nil;
  pid_t child_pid = -1;
  if (!launch_workspace_child_app(bundle_path, arguments, &child_app, child_pid, error)) {
    // 中文原因：真实启动失败必须能区分 LS/NSError 与信号/父退出/超时；只记录固定
    // stage + 有界 detail，不输出 env、路径或用户数据。
    std::fprintf(stderr, "[cua-native] workspace-relay stage=launch-refused pid=%d detail=%s\n",
                 static_cast<int>(getpid()), error.c_str());
    close_owned_socket(listener, socket_path, ownership);
    (void)rmdir(rendezvous_dir.c_str());
    return 2;
  }
  relay_log("child-launched");

  int connection = -1;
  const auto accept_deadline = std::chrono::steady_clock::now() +
                               std::chrono::milliseconds(kWorkspaceAcceptTimeoutMs);
  while (connection < 0) {
    if (g_relay_signal != 0) {
      relay_log("accept-signal");
      break;
    }
    if (!relay_parent_alive()) {
      relay_log("accept-parent-exit");
      break;
    }
    if (std::chrono::steady_clock::now() >= accept_deadline) {
      relay_log("accept-timeout");
      break;
    }
    const int accepted = accept_workspace_peer(listener, kWorkspaceWaitMs, error);
    if (accepted == -1) {
      relay_log("accept-error");
      break;
    }
    if (accepted >= 0) connection = accepted;
  }
  close_owned_socket(listener, socket_path, ownership);
  if (connection < 0) {
    // preaccept：没有连接可 shutdown，等 child 走既有 5s connect timeout 自行退出。
    terminate_workspace_child(child_app, -1);
    (void)rmdir(rendezvous_dir.c_str());
    return 2;
  }

  if (!authenticate_workspace_peer(connection, child_pid, error)) {
    relay_log("peer-auth-refused");
    terminate_workspace_child(child_app, connection);
    (void)close(connection);
    (void)rmdir(rendezvous_dir.c_str());
    return 2;
  }
  relay_log("peer-authenticated");

  if (!relay_send_handoff(connection, context, source_fds, error)) {
    relay_log("handoff-refused");
    terminate_workspace_child(child_app, connection);
    (void)close(connection);
    (void)rmdir(rendezvous_dir.c_str());
    return 2;
  }
  relay_log("handoff-sent");
  close_relay_originals(options);

  int exit_code = 1;
  std::string buffer;
  std::string line;
  bool finished = false;
  while (!finished) {
    if (g_relay_signal != 0) {
      terminate_workspace_child(child_app, connection);
      exit_code = 1;
      break;
    }
    if (!relay_parent_alive()) {
      terminate_workspace_child(child_app, connection);
      exit_code = 1;
      break;
    }
    std::string read_error;
    switch (read_status_line(connection, buffer, line, read_error)) {
      case StatusRead::Line: {
        int code = -1;
        std::string parse_error;
        if (parse_workspace_child_exit_json(line, code, parse_error)) exit_code = code;
        finished = true;
        break;
      }
      case StatusRead::Closed:
        // 中文原因：EOF 不能当成功；没有 child-exit 帧说明 child 崩溃/被中断。
        exit_code = 1;
        finished = true;
        break;
      case StatusRead::Error:
        exit_code = 1;
        finished = true;
        break;
      case StatusRead::Timeout:
        break;
    }
  }
  (void)close(connection);
  (void)rmdir(rendezvous_dir.c_str());
  return exit_code;
}

bool workspace_child_handoff(const WorkspaceChildOptions& options, WorkspaceChildHandoff& handoff,
                             std::string& error) {
  handoff = WorkspaceChildHandoff();
  handoff.entry_name = options.entry_name;
  child_log("handoff-start");
  // 中文原因：child 入口同样只允许固定 entry 白名单，不能依赖后续 fd bundle 校验。
  if (options.entry_name != "host-entry.mjs" && options.entry_name != "cli-entry.mjs" &&
      options.entry_name != "session-entry.mjs") {
    error = "workspace child entry name is not allowed";
    return false;
  }
  if (!workspace_nonce_valid(options.nonce) || options.rendezvous.empty() ||
      options.rendezvous[0] != '/') {
    error = "workspace child association arguments are invalid";
    return false;
  }
  int fd = -1;
  if (!connect_with_deadline(options.rendezvous, 5'000, fd, error)) return false;
  if (!authenticate_workspace_peer(fd, 0, error)) {
    (void)close(fd);
    return false;
  }
  child_log("relay-authenticated");

  WorkspaceContext context;
  std::vector<int> received;
  std::string context_text;
  if (!read_bounded_frame(fd, kWorkspaceMaxContextBytes, 5'000, context_text, error) ||
      !parse_workspace_context_json(context_text, options.entry_name, options.nonce, context,
                                    error) ||
      !workspace_receive_fds(fd, context.fd_count, kWorkspaceFdMarker, received, error)) {
    workspace_close_fds(received);
    (void)close(fd);
    return false;
  }

  if (!workspace_rehome_fds(received, error)) {
    workspace_close_fds(received);
    (void)close(fd);
    return false;
  }
  WorkspaceBridgeFds bridge;
  if (!workspace_bridge_fds_from_bundle(options.entry_name, received, bridge, error)) {
    workspace_close_fds(received);
    (void)close(fd);
    return false;
  }
  // 中文原因：received 已全部 dup 到 >=3，再 dup2 到 stdio 不会覆盖后续 bridge fd。
  if (dup2(received[0], STDIN_FILENO) < 0 || dup2(received[1], STDOUT_FILENO) < 0 ||
      dup2(received[2], STDERR_FILENO) < 0) {
    error = std::string("workspace stdio mapping failed: ") + std::strerror(errno);
    workspace_close_fds(received);
    (void)close(fd);
    return false;
  }
  (void)close(received[0]);
  (void)close(received[1]);
  (void)close(received[2]);
  handoff.host_bridge_fd = bridge.host_bridge_fd;
  handoff.cli_input_fd = bridge.cli_input_fd;
  handoff.cli_output_fd = bridge.cli_output_fd;

  if (!workspace_apply_context(context, error)) {
    workspace_child_close_bridge_fds(handoff);
    (void)close(fd);
    return false;
  }
  handoff.relay_fd = fd;
  child_log("handoff-ready");
  return true;
}

void workspace_child_report_status(int relay_fd, int code) {
  if (relay_fd < 0) return;
  const std::string status = workspace_child_exit_json(code);
  if (status.empty()) return;
  std::string error;
  (void)send_all_fd(relay_fd, status + "\n", error);
}

void workspace_child_close_bridge_fds(WorkspaceChildHandoff& handoff) {
  if (handoff.host_bridge_fd >= 0) (void)close(handoff.host_bridge_fd);
  if (handoff.cli_input_fd >= 0) (void)close(handoff.cli_input_fd);
  if (handoff.cli_output_fd >= 0) (void)close(handoff.cli_output_fd);
  handoff.host_bridge_fd = -1;
  handoff.cli_input_fd = -1;
  handoff.cli_output_fd = -1;
}

}  // namespace zody::cua::desktop_session
