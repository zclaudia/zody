#include "orchestrator.h"

#import <CommonCrypto/CommonDigest.h>
#import <Foundation/Foundation.h>

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <climits>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "authority_client.h"
#include "bundle_paths.h"
#include "capture_owner.h"
#include "machine_lease.h"
#include "node_process.h"
#include "peer_auth.h"
#include "peer_socket.h"
#include "r11_pins.h"
#include "r11_self_identity.h"

namespace zody::cua::round11 {
namespace {

constexpr size_t kMaxAuthorityJsBytes = 8 * 1024 * 1024;
constexpr int kPeerTimeoutMs = 10'000;

std::string json_string(NSDictionary* value) {
  if (value == nil) return "";
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
  if (data == nil || error != nil) return "";
  return std::string(static_cast<const char*>(data.bytes), data.length);
}

std::string uuid_string() {
  return std::string([[[NSUUID UUID] UUIDString] UTF8String]);
}

std::string canonical_workspace() {
  char resolved[PATH_MAX] = {0};
  if (realpath(".", resolved) == nullptr) return "";
  return resolved;
}

bool create_private_run_dir(std::string& directory, std::string& error) {
  directory = "/tmp/io.github.zclaudia.zody.cua-helper." + std::to_string(geteuid()) + "." +
              std::to_string(getpid()) + ".run";
  if (mkdir(directory.c_str(), 0700) != 0) {
    error = std::string("cannot create private run dir: ") + std::strerror(errno);
    return false;
  }
  struct stat info {};
  if (lstat(directory.c_str(), &info) != 0 || !S_ISDIR(info.st_mode) ||
      info.st_uid != geteuid() || (info.st_mode & 0777) != 0700) {
    error = "private run dir failed ownership/mode verification";
    (void)rmdir(directory.c_str());
    return false;
  }
  return true;
}

void cleanup_run_dir(const std::string& directory) {
  if (!directory.empty()) (void)rmdir(directory.c_str());
}

bool spawn_helper(const std::string& peer_socket, const WindowTarget& target, int authority_fd,
                  pid_t& pid, std::string& error) {
  BundlePaths paths;
  if (!resolve_bundle_paths(paths, error)) return false;
  if (!target.output_path.empty()) {
    // output path 由显式开发调用给出；参考授权仍只来自 authority bootstrap。
  }
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  int status = posix_spawn_file_actions_init(&actions);
  if (status == 0) status = posix_spawnattr_init(&attributes);
  const int authority_source = authority_fd >= 0 ? fcntl(authority_fd, F_DUPFD_CLOEXEC, 10) : -1;
  if (status == 0 && authority_source < 0) status = errno;
  if (status == 0)
    status = posix_spawn_file_actions_adddup2(&actions, authority_source, 4);
  if (status == 0)
    status = posix_spawn_file_actions_addclose(&actions, authority_source);
  if (status == 0)
    status = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT);
  if (status != 0) {
    posix_spawn_file_actions_destroy(&actions);
    posix_spawnattr_destroy(&attributes);
    if (authority_source >= 0) close(authority_source);
    error = std::string("helper spawn setup failed: ") + std::strerror(status);
    return false;
  }

  const std::string window_id = std::to_string(target.window_id);
  const std::string pid_text = std::to_string(target.pid);
  const std::string layer_text = std::to_string(target.layer);
  const std::string x = std::to_string(target.x);
  const std::string y = std::to_string(target.y);
  const std::string width = std::to_string(target.width);
  const std::string height = std::to_string(target.height);
  char* argv[] = {
      const_cast<char*>(paths.executable.c_str()),
      const_cast<char*>("--helper"),
      const_cast<char*>("--peer"),
      const_cast<char*>(peer_socket.c_str()),
      const_cast<char*>("--window-id"),
      const_cast<char*>(window_id.c_str()),
      const_cast<char*>("--pid"),
      const_cast<char*>(pid_text.c_str()),
      const_cast<char*>("--layer"),
      const_cast<char*>(layer_text.c_str()),
      const_cast<char*>("--x"),
      const_cast<char*>(x.c_str()),
      const_cast<char*>("--y"),
      const_cast<char*>(y.c_str()),
      const_cast<char*>("--width"),
      const_cast<char*>(width.c_str()),
      const_cast<char*>("--height"),
      const_cast<char*>(height.c_str()),
      nullptr,
  };
  char* envp[] = {
      const_cast<char*>("PATH=/usr/bin:/bin"),
      const_cast<char*>("LANG=C"),
      const_cast<char*>("LC_ALL=C"),
      nullptr,
  };
  status = posix_spawn(&pid, paths.executable.c_str(), &actions, &attributes, argv, envp);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attributes);
  if (authority_source >= 0) close(authority_source);
  if (status != 0) {
    error = std::string("posix_spawn helper failed: ") + std::strerror(status);
    return false;
  }
  return true;
}

bool wait_child(pid_t pid, int timeout_ms, int& code, std::string& error) {
  for (int elapsed = 0; elapsed < timeout_ms; elapsed += 20) {
    int status = 0;
    const pid_t result = waitpid(pid, &status, WNOHANG);
    if (result == pid) {
      code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      return true;
    }
    if (result < 0 && errno != EINTR) {
      error = std::string("waitpid failed: ") + std::strerror(errno);
      return false;
    }
    usleep(20'000);
  }
  error = "helper did not exit";
  return false;
}

bool png_dimensions_path(const std::string& path, uint32_t& width, uint32_t& height,
                         std::string& error) {
  const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    error = std::string("cannot open helper PNG: ") + std::strerror(errno);
    return false;
  }
  uint8_t header[24] = {0};
  size_t offset = 0;
  while (offset < sizeof(header)) {
    const ssize_t count = read(fd, header + offset, sizeof(header) - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      error = std::string("cannot read helper PNG header: ") + std::strerror(errno);
      close(fd);
      return false;
    }
    if (count == 0) break;
    offset += static_cast<size_t>(count);
  }
  close(fd);
  static const uint8_t signature[8] = {137, 80, 78, 71, 13, 10, 26, 10};
  if (offset != sizeof(header) || std::memcmp(header, signature, sizeof(signature)) != 0 ||
      std::memcmp(header + 12, "IHDR", 4) != 0) {
    error = "helper PNG header is invalid";
    return false;
  }
  width = (static_cast<uint32_t>(header[16]) << 24) |
          (static_cast<uint32_t>(header[17]) << 16) |
          (static_cast<uint32_t>(header[18]) << 8) | header[19];
  height = (static_cast<uint32_t>(header[20]) << 24) |
           (static_cast<uint32_t>(header[21]) << 16) |
           (static_cast<uint32_t>(header[22]) << 8) | header[23];
  return width > 0 && height > 0;
}

bool sha256_path(const std::string& path, std::string& digest, size_t& size, std::string& error) {
  const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    error = std::string("cannot open helper PNG: ") + std::strerror(errno);
    return false;
  }
  struct stat info {};
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size <= 0) {
    error = "helper PNG is not a non-empty regular file";
    close(fd);
    return false;
  }
  size = static_cast<size_t>(info.st_size);
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  uint8_t buffer[64 * 1024];
  while (true) {
    const ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count < 0) {
      if (errno == EINTR) continue;
      error = std::string("cannot read helper PNG: ") + std::strerror(errno);
      close(fd);
      return false;
    }
    if (count == 0) break;
    CC_SHA256_Update(&context, buffer, static_cast<CC_LONG>(count));
  }
  close(fd);
  uint8_t raw[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(raw, &context);
  static const char* hex = "0123456789abcdef";
  digest.clear();
  for (uint8_t byte : raw) {
    digest.push_back(hex[(byte >> 4) & 0x0f]);
    digest.push_back(hex[byte & 0x0f]);
  }
  return true;
}

// 中文原因：supervisor 退出后 peer socket EOF 必须立即让 authority reader 走
// producerLost/on_closed 取消；不能让 Helper/Node 孤儿继续 candidate 并落盘。
// monitor 只调用 interrupt（shutdown），不 close/join/销毁，避免与 capture 的
// 正常 cleanup 竞态；主线程在 capture 结束后先 stop/join 再销毁对象。
struct PeerMonitor {
  std::thread thread;
  std::atomic<bool> stop{false};
  std::atomic<bool> disconnected{false};
};

void peer_monitor_loop(int fd, AuthorityClient* authority, PeerMonitor* monitor) {
  while (!monitor->stop.load()) {
    struct pollfd descriptor {};
    descriptor.fd = fd;
    descriptor.events = POLLIN;
    const int ready = poll(&descriptor, 1, 100);
    if (ready < 0) {
      if (errno == EINTR) continue;
      monitor->disconnected.store(true);
      authority->interrupt();
      return;
    }
    if (ready == 0) continue;
    if ((descriptor.revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) == 0) continue;
    char byte = 0;
    const ssize_t count = recv(fd, &byte, 1, MSG_DONTWAIT);
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
      continue;
    }
    // 0=EOF，其他错误=连接不可用；>0 是 supervisor 在 go 之后不应发送的数据。
    monitor->disconnected.store(true);
    authority->interrupt();
    return;
  }
}

bool start_peer_monitor(int fd, AuthorityClient* authority, PeerMonitor& monitor,
                        std::string& error) {
  try {
    monitor.thread = std::thread(peer_monitor_loop, fd, authority, &monitor);
    return true;
  } catch (const std::exception& exception) {
    error = std::string("peer monitor start failed: ") + exception.what();
    return false;
  }
}

void stop_peer_monitor(PeerMonitor& monitor) {
  monitor.stop.store(true);
  if (monitor.thread.joinable()) monitor.thread.join();
}

}  // namespace

int run_once(const WindowTarget& target, std::string& status, std::string& reason) {
  PinnedIdentity pinned = pinned_identity();
  SelfPreflight self = evaluate_self_preflight(pinned);
  if (!self.ok) {
    status = "blocked";
    reason = self.reason;
    return 3;
  }
  if (target.window_id == 0 || target.output_path.empty()) {
    status = "blocked";
    reason = "window-target-or-output-required";
    return 3;
  }
  const std::string workspace = canonical_workspace();
  if (workspace.empty()) {
    status = "blocked";
    reason = "canonical-workspace-unavailable";
    return 3;
  }

  BundlePaths paths;
  std::string error;
  if (!resolve_bundle_paths(paths, error)) {
    status = "blocked";
    reason = error;
    return 3;
  }
  ResourcePins pins = resource_pins();
  VerifiedResource node;
  if (!open_verified_resource(paths.node, pins.node_sha256, node, error)) {
    status = "blocked";
    reason = error;
    return 3;
  }
  std::string authority_js;
  if (!read_verified_snapshot(paths.authority_entry, pins.authority_sha256, kMaxAuthorityJsBytes,
                              authority_js, error)) {
    status = "blocked";
    reason = error;
    return 3;
  }

  AuthorityNode node_process;
  if (!launch_authority_node(paths.node, node.fd, authority_js, node_loaded_code_expectation(),
                             node_process, error)) {
    status = "blocked";
    reason = error;
    return 3;
  }
  node.close();

  const std::string trace_id = uuid_string();
  const std::string app_incarnation = uuid_string();
  const std::string producer = "producer-" + uuid_string();
  const std::string run_id = "run-" + uuid_string();
  const std::string turn_id = "turn-" + uuid_string();
  NSDictionary* bootstrap = @{
    @"traceId" : [NSString stringWithUTF8String:trace_id.c_str()],
    @"appIncarnation" : [NSString stringWithUTF8String:app_incarnation.c_str()],
    @"hostInstanceId" : [NSString stringWithUTF8String:("host-" + uuid_string()).c_str()],
    @"runtimeInstanceId" : [NSString stringWithUTF8String:("runtime-" + uuid_string()).c_str()],
    @"sessionId" : [NSString stringWithUTF8String:("session-" + uuid_string()).c_str()],
    @"workspaceKey" : [NSString stringWithUTF8String:workspace.c_str()],
    @"sourceCommandId" : [NSString stringWithUTF8String:("command-" + uuid_string()).c_str()],
    @"queueItemId" : [NSString stringWithUTF8String:("queue-" + uuid_string()).c_str()],
    @"producerIncarnation" : [NSString stringWithUTF8String:producer.c_str()],
    @"runId" : [NSString stringWithUTF8String:run_id.c_str()],
    @"turnId" : [NSString stringWithUTF8String:turn_id.c_str()],
  };
  NSDictionary* bootstrapped = nil;
  if (!authority_request_once(node_process.authority_fd, @"bootstrap", bootstrap, &bootstrapped,
                              error)) {
    status = "blocked";
    reason = error;
    node_process.stop();
    return 3;
  }
  NSDictionary* ref = bootstrapped[@"ref"];
  if (![bootstrapped[@"ok"] boolValue] || ref == nil) {
    status = "blocked";
    reason = "authority-bootstrap-rejected";
    node_process.stop();
    return 3;
  }

  std::string run_dir;
  if (!create_private_run_dir(run_dir, error)) {
    status = "blocked";
    reason = error;
    node_process.stop();
    return 3;
  }
  const std::string socket_path = run_dir + "/peer.sock";
  int listener = -1;
  SocketOwnership ownership;
  if (!create_private_listener(socket_path, listener, ownership, error)) {
    cleanup_run_dir(run_dir);
    node_process.stop();
    status = "blocked";
    reason = error;
    return 3;
  }

  pid_t helper_pid = -1;
  if (!spawn_helper(socket_path, target, node_process.authority_fd, helper_pid, error)) {
    close_owned_socket(listener, socket_path, ownership);
    cleanup_run_dir(run_dir);
    node_process.stop();
    status = "blocked";
    reason = error;
    return 3;
  }
  // 唯一 owner 转交 Helper；supervisor 不再读写该 fd。
  node_process.close_authority();

  int helper_fd = -1;
  if (!accept_one_with_deadline(listener, kPeerTimeoutMs, helper_fd, error)) {
    close_owned_socket(listener, socket_path, ownership);
    (void)kill(helper_pid, SIGKILL);
    (void)waitpid(helper_pid, nullptr, 0);
    cleanup_run_dir(run_dir);
    node_process.stop();
    status = "blocked";
    reason = error;
    return 3;
  }
  close_owned_socket(listener, socket_path, ownership);
  listener = -1;

  PeerExpectation helper_expectation;
  helper_expectation.pid = helper_pid;
  helper_expectation.uid = geteuid();
  helper_expectation.bundle_id = pinned.bundle_id;
  helper_expectation.leaf_certificate_sha256 = pinned.leaf_certificate_sha256;
  helper_expectation.designated_requirement = pinned.designated_requirement;
  PeerAuthResult peer;
  if (!supervisor_handshake(helper_fd, helper_expectation, peer, error)) {
    close(helper_fd);
    (void)kill(helper_pid, SIGKILL);
    (void)waitpid(helper_pid, nullptr, 0);
    cleanup_run_dir(run_dir);
    node_process.stop();
    status = "blocked";
    reason = "helper-peer-auth: " + error;
    return 3;
  }

  NSDictionary* go = @{
    @"traceId" : [NSString stringWithUTF8String:trace_id.c_str()],
    @"ref" : ref,
    @"producerIncarnation" : [NSString stringWithUTF8String:producer.c_str()],
    @"runId" : [NSString stringWithUTF8String:run_id.c_str()],
    @"turnId" : [NSString stringWithUTF8String:turn_id.c_str()],
    @"outputPath" : [NSString stringWithUTF8String:target.output_path.c_str()],
    @"target" : @{
      @"windowId" : @(target.window_id),
      @"pid" : @(target.pid),
      @"layer" : @(target.layer),
      @"x" : @(target.x),
      @"y" : @(target.y),
      @"width" : @(target.width),
      @"height" : @(target.height),
    },
  };
  const std::string go_json = json_string(go);
  if (go_json.empty() || !write_bounded_frame(helper_fd, go_json, 5'000, error)) {
    close(helper_fd);
    (void)kill(helper_pid, SIGKILL);
    (void)waitpid(helper_pid, nullptr, 0);
    cleanup_run_dir(run_dir);
    node_process.stop();
    status = "blocked";
    reason = "helper-go-delivery-failed";
    return 3;
  }

  std::string helper_response;
  if (!read_bounded_frame(helper_fd, 64 * 1024, 30'000, helper_response, error)) {
    close(helper_fd);
    (void)kill(helper_pid, SIGKILL);
    (void)waitpid(helper_pid, nullptr, 0);
    cleanup_run_dir(run_dir);
    node_process.stop();
    status = "blocked";
    reason = "helper-result-transport-failed";
    return 3;
  }
  close(helper_fd);
  int helper_code = 0;
  bool exited = wait_child(helper_pid, 15'000, helper_code, error);
  if (!exited) {
    (void)kill(helper_pid, SIGKILL);
    (void)waitpid(helper_pid, nullptr, 0);
  }
  cleanup_run_dir(run_dir);
  node_process.stop();
  const bool node_cleanup_pending = node_process.cleanup_pending;

  NSData* response_data = [NSData dataWithBytes:helper_response.data()
                                         length:helper_response.size()];
  NSError* json_error = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:response_data options:0 error:&json_error];
  if (parsed == nil || ![parsed isKindOfClass:[NSDictionary class]]) {
    status = "blocked";
    reason = "helper-result-invalid-json";
    return 3;
  }
  NSDictionary* result = static_cast<NSDictionary*>(parsed);
  if (!exited || helper_code != 0) {
    status = "blocked";
    reason = "helper-exit-not-success";
    return 3;
  }
  if (![result[@"ok"] isKindOfClass:[NSNumber class]] ||
      ![result[@"revoked"] isKindOfClass:[NSNumber class]] ||
      ![result[@"resourcesReleased"] isKindOfClass:[NSNumber class]] ||
      ![result[@"machineLeaseReleased"] isKindOfClass:[NSNumber class]] ||
      ![result[@"ok"] boolValue] || ![result[@"revoked"] boolValue] ||
      ![result[@"resourcesReleased"] boolValue] ||
      ![result[@"machineLeaseReleased"] boolValue]) {
    status = "blocked";
    reason = [result[@"reason"] isKindOfClass:[NSString class]]
                 ? std::string([static_cast<NSString*>(result[@"reason"]) UTF8String])
                 : "helper-capture-not-confirmed";
    return 4;
  }
  if (node_cleanup_pending) {
    // authority Node 未被确认回收时，不允许把一次 helper 成功当成整体成功。
    status = "blocked";
    reason = "authority-node-not-reaped";
    return 3;
  }
  NSNumber* width = result[@"width"];
  NSNumber* height = result[@"height"];
  NSString* expected_sha = result[@"pngSha256"];
  if (![width isKindOfClass:[NSNumber class]] || ![height isKindOfClass:[NSNumber class]] ||
      [width unsignedIntValue] == 0 || [height unsignedIntValue] == 0 ||
      ![expected_sha isKindOfClass:[NSString class]] ||
      [static_cast<NSString*>(expected_sha) length] != 64) {
    status = "blocked";
    reason = "helper-result-missing-png-facts";
    return 4;
  }
  std::string actual_sha;
  size_t png_size = 0;
  std::string hash_error;
  uint32_t actual_width = 0;
  uint32_t actual_height = 0;
  if (!sha256_path(target.output_path, actual_sha, png_size, hash_error) ||
      actual_sha != std::string([static_cast<NSString*>(expected_sha) UTF8String]) ||
      png_size < 24 || !png_dimensions_path(target.output_path, actual_width, actual_height,
                                            hash_error) ||
      actual_width != [width unsignedIntValue] ||
      actual_height != [height unsignedIntValue]) {
    status = "blocked";
    reason = "helper-png-file-not-verified";
    return 4;
  }
  status = "pass";
  reason = "captured-and-revoked";
  return 0;
}

int run_helper(const std::string& peer_socket, const WindowTarget& target, std::string& status,
               std::string& reason) {
  PinnedIdentity pinned = pinned_identity();
  SelfPreflight self = evaluate_self_preflight(pinned);
  if (!self.ok) {
    status = "blocked";
    reason = self.reason;
    return 3;
  }
  if (peer_socket.empty() || target.window_id == 0) {
    status = "blocked";
    reason = "helper-peer-or-target-missing";
    return 3;
  }
  std::string error;
  int fd = -1;
  if (!connect_with_deadline(peer_socket, kPeerTimeoutMs, fd, error)) {
    status = "blocked";
    reason = error;
    return 3;
  }
  PeerExpectation supervisor_expectation;
  supervisor_expectation.pid = getppid();
  supervisor_expectation.uid = geteuid();
  supervisor_expectation.bundle_id = pinned.bundle_id;
  supervisor_expectation.leaf_certificate_sha256 = pinned.leaf_certificate_sha256;
  supervisor_expectation.designated_requirement = pinned.designated_requirement;
  PeerAuthResult peer;
  if (!helper_handshake(fd, supervisor_expectation, peer, error)) {
    close(fd);
    status = "blocked";
    reason = "supervisor-peer-auth: " + error;
    return 3;
  }
  std::string go;
  if (!read_bounded_frame(fd, 64 * 1024, 10'000, go, error)) {
    close(fd);
    status = "blocked";
    reason = "go-read-failed";
    return 3;
  }
  NSData* data = [NSData dataWithBytes:go.data() length:go.size()];
  NSError* json_error = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&json_error];
  if (parsed == nil || ![parsed isKindOfClass:[NSDictionary class]]) {
    close(fd);
    status = "blocked";
    reason = "go-invalid-json";
    return 3;
  }
  NSDictionary* go_frame = static_cast<NSDictionary*>(parsed);
  NSDictionary* ref = go_frame[@"ref"];
  NSDictionary* target_frame = go_frame[@"target"];
  if (ref == nil || target_frame == nil) {
    close(fd);
    status = "blocked";
    reason = "go-ref-or-target-missing";
    return 3;
  }

  CaptureRequestContext context;
  context.ref = ref;
  context.trace_id = go_frame[@"traceId"];
  context.producer_incarnation = go_frame[@"producerIncarnation"];
  context.run_id = go_frame[@"runId"];
  context.turn_id = go_frame[@"turnId"];
  context.output_path = go_frame[@"outputPath"];
  context.window_id = [target_frame[@"windowId"] unsignedIntValue];
  context.pid = [target_frame[@"pid"] intValue];
  context.layer = [target_frame[@"layer"] intValue];
  context.x = [target_frame[@"x"] doubleValue];
  context.y = [target_frame[@"y"] doubleValue];
  context.width = [target_frame[@"width"] doubleValue];
  context.height = [target_frame[@"height"] doubleValue];

  auto lease = std::make_unique<MachineLease>();
  const MachineLeaseResult lease_result = lease->acquire();
  CaptureOutcome outcome;
  bool machine_lease_released = !lease->held();
  if (lease_result.status == MachineLeaseResult::Status::Busy) {
    outcome.reason = "machine-busy";
  } else if (!lease_result.acquired()) {
    outcome.reason = "machine-lease-invalid";
  } else {
    auto authority = std::make_unique<AuthorityClient>(4);
    PeerMonitor monitor;
    if (!start_peer_monitor(fd, authority.get(), monitor, error)) {
      outcome.reason = "peer-monitor-unavailable";
      stop_peer_monitor(monitor);
    } else {
      outcome = capture_once(*authority, *lease, context);
      stop_peer_monitor(monitor);
      if (monitor.disconnected.load()) {
        // supervisor 已离开；即使 capture 刚好完成并 revoke，也不能报告成功。
        // 只删除本次确实写出的 PNG（png_sha256 仅在成功创建后赋值），不能碰
        // 采集前就存在或 O_EXCL 争用失败的用户文件。
        if (!outcome.png_sha256.empty() && context.output_path != nil) {
          (void)unlink([context.output_path UTF8String]);
        }
        outcome.ok = false;
        outcome.reason = "supervisor-disconnected";
      }
    }
    if (outcome.resources_released) {
      authority->close();
      authority.reset();
      lease->release();
      machine_lease_released = true;
    } else {
      // 中文原因：callback 资源未归还时 stack/对象仍可能被 Swift 线程使用。
      // 不能 close authority 或释放 lease；故意保留到 Helper 进程终止。
      authority.release();
      lease.release();
      machine_lease_released = false;
    }
  }

  NSDictionary* result = @{
    @"ok" : @(outcome.ok),
    @"reason" : [NSString stringWithUTF8String:outcome.reason.c_str()],
    @"pngSha256" : [NSString stringWithUTF8String:outcome.png_sha256.c_str()],
    @"width" : @(outcome.width),
    @"height" : @(outcome.height),
    @"revoked" : @(outcome.revoked),
    @"resourcesReleased" : @(outcome.resources_released),
    @"machineLeaseReleased" : @(machine_lease_released),
  };
  const std::string result_json = json_string(result);
  if (!result_json.empty()) (void)write_bounded_frame(fd, result_json, 5'000, error);
  close(fd);
  status = outcome.ok ? "pass" : "blocked";
  reason = outcome.reason;
  return outcome.ok ? 0 : 4;
}

}  // namespace zody::cua::round11
