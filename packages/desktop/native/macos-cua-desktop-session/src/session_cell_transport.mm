#include "session_cell_transport.h"

#import <Foundation/Foundation.h>

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "bundle_paths.h"
#include "peer_auth.h"
#include "session_cell_protocol.h"
#include "session_cell_relay.h"
#include "session_node_process.h"
#include "session_transport_auth.h"

extern char** environ;

namespace zody::cua::desktop_session {
namespace {

// 有界 native audit：只输出固定事件和 identity/exit 事实，不输出 code、request、
// capability、env、路径或 ready 自报字段。字符串统一剥离控制字符并截断。
std::string bounded_audit_text(const std::string& value, size_t max_bytes) {
  std::string out;
  out.reserve(std::min(value.size(), max_bytes));
  for (unsigned char byte : value) {
    if (out.size() >= max_bytes) break;
    if (byte >= 0x20 && byte < 0x7f && byte != '"' && byte != '\\') {
      out.push_back(static_cast<char>(byte));
    } else {
      out.push_back('?');
    }
  }
  return out;
}

void log_cell_spawned(pid_t pid, bool suspended) {
  std::fprintf(stderr, "[cua-native] cell-spawned {\"pid\":%d,\"suspended\":%s}\n", pid,
               suspended ? "true" : "false");
}

void log_cell_loaded_code(pid_t pid, const SuspendedNodeVerification& verification) {
  const std::string identifier = bounded_audit_text(verification.loaded_identifier, 256);
  const std::string cdhash = bounded_audit_text(verification.loaded_cdhash_hex, 64);
  std::fprintf(stderr,
               "[cua-native] cell-loaded-code {\"pid\":%d,\"verified\":%s,"
               "\"identifier\":\"%s\",\"cdhash\":\"%s\",\"entitlementsEmpty\":%s}\n",
               pid, verification.verified ? "true" : "false", identifier.c_str(), cdhash.c_str(),
               verification.entitlements_empty ? "true" : "false");
}

void log_cell_resumed(pid_t pid) {
  std::fprintf(stderr, "[cua-native] cell-resumed {\"pid\":%d}\n", pid);
}

void log_cell_source_sent(pid_t pid, size_t bytes) {
  std::fprintf(stderr, "[cua-native] cell-source-sent {\"pid\":%d,\"bytes\":%zu}\n", pid,
               bytes);
}

void log_cell_peer_verified(pid_t pid, const zody::cua::round11::LoadedCodeResult& loaded) {
  const std::string identifier = bounded_audit_text(loaded.identifier, 256);
  const std::string cdhash = bounded_audit_text(loaded.cdhash_hex, 64);
  std::fprintf(stderr,
               "[cua-native] cell-peer-verified {\"pid\":%d,\"identifier\":\"%s\","
               "\"cdhash\":\"%s\",\"entitlementsEmpty\":%s}\n",
               pid, identifier.c_str(), cdhash.c_str(),
               loaded.entitlements_empty ? "true" : "false");
}

void log_cell_reaped(pid_t pid, bool confirmed, bool status_known, int status) {
  bool exited = status_known && WIFEXITED(status);
  bool signaled = status_known && WIFSIGNALED(status);
  std::string exit_code = "null";
  std::string signal_value = "null";
  if (exited) exit_code = std::to_string(WEXITSTATUS(status));
  if (signaled) signal_value = std::to_string(WTERMSIG(status));
  std::fprintf(stderr,
               "[cua-native] cell-reaped {\"pid\":%d,\"confirmed\":%s,"
               "\"exitCode\":%s,\"signal\":%s}\n",
               pid, confirmed ? "true" : "false", exit_code.c_str(), signal_value.c_str());
}

constexpr int kRelayPollMs = 250;
constexpr int kOpenFrameTimeoutMs = 5'000;
constexpr int kReadyWriteTimeoutMs = 5'000;
constexpr int kSourceWriteTimeoutMs = 10'000;
constexpr int kExitWaitMs = 5'000;
constexpr int kKillReapMs = 2'000;

void close_if_needed(int& fd) {
  if (fd >= 0) close(fd);
  fd = -1;
}

bool set_nonblocking(int fd, std::string& error) {
  const int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0) {
    error = std::string("cell fd nonblocking failed: ") + std::strerror(errno);
    return false;
  }
  // 中文原因：Helper 中继写端关闭的 pipe/socket 时必须避免 SIGPIPE 终止整个 Helper。
  (void)fcntl(fd, F_SETNOSIGPIPE, 1);
  return true;
}

bool wait_fd(int fd, short events, int timeout_ms, const std::atomic<bool>& stop) {
  if (stop.load(std::memory_order_acquire)) return false;
  struct pollfd entry {};
  entry.fd = fd;
  entry.events = events;
  const int result = poll(&entry, 1, timeout_ms);
  if (result < 0 && errno == EINTR) return wait_fd(fd, events, timeout_ms, stop);
  return result > 0 && (entry.revents & (events | POLLHUP | POLLERR)) != 0;
}

bool write_all_fd(int fd, const char* data, size_t size, int timeout_ms,
                  const std::atomic<bool>& stop, std::string& error) {
  size_t offset = 0;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (offset < size) {
    if (stop.load(std::memory_order_acquire)) {
      error = "cell transport stopping";
      return false;
    }
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                               deadline - std::chrono::steady_clock::now())
                               .count();
    if (remaining <= 0) {
      error = "cell write timed out";
      return false;
    }
    if (!wait_fd(fd, POLLOUT, static_cast<int>(remaining), stop)) {
      error = "cell write wait failed";
      return false;
    }
    const ssize_t count = write(fd, data + offset, size - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
      error = std::string("cell write failed: ") + std::strerror(errno);
      return false;
    }
    if (count == 0) {
      error = "cell write made no progress";
      return false;
    }
    offset += static_cast<size_t>(count);
  }
  return true;
}

bool read_line_bounded(int fd, size_t max_bytes, int timeout_ms,
                       const std::atomic<bool>& stop, std::string& line, std::string& error) {
  line.clear();
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (true) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                               deadline - std::chrono::steady_clock::now())
                               .count();
    if (remaining <= 0) {
      error = "cell open frame timed out";
      return false;
    }
    if (!wait_fd(fd, POLLIN, static_cast<int>(remaining), stop)) {
      error = stop.load(std::memory_order_acquire) ? "cell transport stopping"
                                                   : "cell open frame unavailable";
      return false;
    }
    char chunk[4096];
    const ssize_t count = recv(fd, chunk, sizeof(chunk), 0);
    if (count == 0) {
      error = "cell open frame eof";
      return false;
    }
    if (count < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
      error = std::string("cell open frame read failed: ") + std::strerror(errno);
      return false;
    }
    line.append(chunk, static_cast<size_t>(count));
    if (line.size() > max_bytes) {
      error = "cell open frame too large";
      return false;
    }
    const size_t newline = line.find('\n');
    if (newline != std::string::npos) {
      line.resize(newline);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      error.clear();
      return true;
    }
  }
}

bool make_pipe(int fds[2], std::string& error) {
  int raw[2] = {-1, -1};
  if (pipe(raw) != 0) {
    error = std::string("cell pipe failed: ") + std::strerror(errno);
    return false;
  }
  fds[0] = fcntl(raw[0], F_DUPFD_CLOEXEC, 10);
  fds[1] = fcntl(raw[1], F_DUPFD_CLOEXEC, 10);
  const int failure = errno;
  close(raw[0]);
  close(raw[1]);
  if (fds[0] < 0 || fds[1] < 0) {
    close_if_needed(fds[0]);
    close_if_needed(fds[1]);
    error = std::string("cell pipe normalization failed: ") + std::strerror(failure);
    return false;
  }
  return true;
}

struct CellSpawn {
  pid_t pid = -1;
  int source_write = -1;
  int request_write = -1;
  int response_read = -1;
};

bool spawn_suspended_cell(const CellTransportConfig& config, CellSpawn& spawn,
                          std::string& error, bool& child_cleanup_unknown) {
  spawn = CellSpawn();
  child_cleanup_unknown = false;
  if (!zody::cua::round11::verify_path_matches_fd(config.node_path, config.node_fd, error)) {
    return false;
  }
  int source[2] = {-1, -1};
  int request[2] = {-1, -1};
  int response[2] = {-1, -1};
  int devnull = -1;
  auto cleanup = [&]() {
    close_if_needed(source[0]);
    close_if_needed(source[1]);
    close_if_needed(request[0]);
    close_if_needed(request[1]);
    close_if_needed(response[0]);
    close_if_needed(response[1]);
    close_if_needed(devnull);
  };
  if (!make_pipe(source, error) || !make_pipe(request, error) ||
      !make_pipe(response, error)) {
    cleanup();
    return false;
  }
  const int raw_devnull = open("/dev/null", O_WRONLY | O_CLOEXEC);
  if (raw_devnull < 0) {
    error = std::string("cannot open /dev/null: ") + std::strerror(errno);
    cleanup();
    return false;
  }
  // 中文原因：devnull 未归一化时若恰好拿到 3/4，adddup2(request,3) 之后
  // addclose(devnull=3) 会关掉刚建立的 cell 请求 fd。所有 action source fd
  // 必须 >=10。
  devnull = fcntl(raw_devnull, F_DUPFD_CLOEXEC, 10);
  const int devnull_failure = errno;
  close(raw_devnull);
  if (devnull < 0) {
    cleanup();
    error = std::string("cell devnull normalization failed: ") +
            std::strerror(devnull_failure);
    return false;
  }

  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  bool actions_ready = false;
  bool attributes_ready = false;
  int status = posix_spawn_file_actions_init(&actions);
  if (status == 0) {
    actions_ready = true;
    status = posix_spawnattr_init(&attributes);
    if (status == 0) attributes_ready = true;
  }
  if (status == 0) status = posix_spawn_file_actions_adddup2(&actions, source[0], STDIN_FILENO);
  if (status == 0) status = posix_spawn_file_actions_adddup2(&actions, devnull, STDOUT_FILENO);
  if (status == 0) status = posix_spawn_file_actions_adddup2(&actions, devnull, STDERR_FILENO);
  if (status == 0) status = posix_spawn_file_actions_adddup2(&actions, request[0], 3);
  if (status == 0) status = posix_spawn_file_actions_adddup2(&actions, response[1], 4);
  for (const int fd : {source[0], source[1], request[0], request[1], response[0], response[1], devnull}) {
    if (status == 0) status = posix_spawn_file_actions_addclose(&actions, fd);
  }
  if (status == 0)
    status = posix_spawnattr_setflags(
        &attributes, POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_START_SUSPENDED);
  if (status != 0) {
    // 中文原因：某个 init 失败时不能 destroy 未初始化的 attr/actions。
    if (actions_ready) posix_spawn_file_actions_destroy(&actions);
    if (attributes_ready) posix_spawnattr_destroy(&attributes);
    cleanup();
    error = std::string("cell posix_spawn setup failed: ") + std::strerror(status);
    return false;
  }

  char* argv[] = {
      const_cast<char*>(config.node_path.c_str()),
      const_cast<char*>("--jitless"),
      const_cast<char*>("--no-warnings"),
      const_cast<char*>("--input-type=module"),
      const_cast<char*>("-"),
      const_cast<char*>("--zcode-node-repl-cell"),
      nullptr,
  };
  std::vector<std::string> environment = filtered_node_environment();
  std::vector<char*> envp;
  envp.reserve(environment.size() + 1);
  for (std::string& entry : environment) envp.push_back(entry.data());
  envp.push_back(nullptr);

  pid_t pid = -1;
  const int spawn_status =
      posix_spawn(&pid, config.node_path.c_str(), &actions, &attributes, argv, envp.data());
  if (actions_ready) posix_spawn_file_actions_destroy(&actions);
  if (attributes_ready) posix_spawnattr_destroy(&attributes);
  close_if_needed(source[0]);
  close_if_needed(request[0]);
  close_if_needed(response[1]);
  close_if_needed(devnull);
  if (spawn_status != 0) {
    close_if_needed(source[1]);
    close_if_needed(request[1]);
    close_if_needed(response[0]);
    error = std::string("cell posix_spawn failed: ") + std::strerror(spawn_status);
    return false;
  }

  spawn.pid = pid;
  spawn.source_write = source[1];
  spawn.request_write = request[1];
  spawn.response_read = response[0];
  // 中文原因：fcntl 失败时后续 relay 可能永久阻塞；必须立即 kill 真实 child 并
  // 有界 reap，失败则把 unknown cleanup 上报给 slot 记账，不能继续服务。
  std::string nonblocking_error;
  if (!set_nonblocking(spawn.source_write, nonblocking_error) ||
      !set_nonblocking(spawn.request_write, nonblocking_error) ||
      !set_nonblocking(spawn.response_read, nonblocking_error)) {
    int status = 0;
    bool status_known = false;
    const bool reaped =
        kill_and_reap_suspended_node(pid, kKillReapMs, status, status_known);
    log_cell_spawned(pid, true);
    log_cell_reaped(pid, reaped && status_known, status_known, status);
    child_cleanup_unknown = !(reaped && status_known);
    close_if_needed(source[1]);
    close_if_needed(request[1]);
    close_if_needed(response[0]);
    spawn = CellSpawn();
    error = nonblocking_error;
    return false;
  }
  return true;
}

bool wait_child(pid_t pid, int timeout_ms, int& status_out, bool& known) {
  known = false;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (std::chrono::steady_clock::now() < deadline) {
    int status = 0;
    const pid_t result = waitpid(pid, &status, WNOHANG);
    if (result == pid) {
      status_out = status;
      known = true;
      return true;
    }
    if (result < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    usleep(20'000);
  }
  return false;
}

bool send_fixed_error(int fd, const std::string& reason,
                      const std::atomic<bool>& stop) {
  const std::string line = serialize_cell_error(reason);
  if (line.empty()) return false;
  std::string error;
  return write_all_fd(fd, line.data(), line.size(), 1'000, stop, error);
}

void shutdown_and_close(int& fd) {
  if (fd < 0) return;
  (void)shutdown(fd, SHUT_RDWR);
  close(fd);
  fd = -1;
}

}  // namespace

CellTransport::CellTransport() = default;

CellTransport::~CellTransport() { stop(); }

bool CellTransport::start(const CellTransportConfig& config, std::string& error) {
  if (started_.load(std::memory_order_acquire)) {
    error = "cell transport already started";
    return false;
  }
  if (config.run_dir.empty() || config.node_path.empty() || config.node_fd < 0 ||
      config.server_source.empty() || config.server_sha256.size() != 64 ||
      config.cli_pid <= 0 ||
      !is_valid_transport_authentication_key(config.transport_authentication_key)) {
    error = "cell transport configuration incomplete";
    return false;
  }
  if (!zody::cua::round11::verify_path_matches_fd(config.node_path, config.node_fd, error)) {
    return false;
  }
  config_ = config;
  if (config_.relay_timeout_ms <= 0) config_.relay_timeout_ms = 1'800'000;
  endpoint_ = config.run_dir + "/cell.sock";
  if (!create_private_listener(endpoint_, listener_fd_, ownership_, error)) return false;
  // 中文原因：accept_one_with_deadline 依赖非阻塞 listener；否则 stop() 在无连接时
  // 会阻塞在 accept 上，整个 Helper 停机不再有界。
  if (!set_nonblocking(listener_fd_, error)) {
    close_owned_socket(listener_fd_, endpoint_, ownership_);
    listener_fd_ = -1;
    return false;
  }
  stop_.store(false, std::memory_order_release);
  started_.store(true, std::memory_order_release);
  accept_thread_ = std::thread([this] { accept_loop(); });
  return true;
}

void CellTransport::stop() {
  stop_.store(true, std::memory_order_release);
  if (accept_thread_.joinable()) accept_thread_.join();
  if (listener_fd_ >= 0) {
    close_owned_socket(listener_fd_, endpoint_, ownership_);
    listener_fd_ = -1;
  }
  std::vector<WorkerRecord> local;
  {
    std::lock_guard<std::mutex> lock(workers_mutex_);
    local.swap(workers_);
  }
  for (WorkerRecord& worker : local) {
    if (worker.thread.joinable()) worker.thread.join();
  }
  started_.store(false, std::memory_order_release);
}

size_t CellTransport::activeWorkers() const {
  std::lock_guard<std::mutex> lock(workers_mutex_);
  return active_workers_;
}

bool CellTransport::cleanupFullyKnown() const {
  std::lock_guard<std::mutex> lock(workers_mutex_);
  return !cleanup_unknown_;
}

void CellTransport::prune_finished_workers_locked() {
  for (auto iterator = workers_.begin(); iterator != workers_.end();) {
    if (iterator->done != nullptr &&
        iterator->done->load(std::memory_order_acquire)) {
      if (iterator->thread.joinable()) iterator->thread.join();
      iterator = workers_.erase(iterator);
    } else {
      ++iterator;
    }
  }
}

bool CellTransport::reserve_slot() {
  std::lock_guard<std::mutex> lock(workers_mutex_);
  if (active_workers_ >= kCellMaxConcurrent) return false;
  ++active_workers_;
  return true;
}

void CellTransport::release_slot(bool cleanup_known) {
  std::lock_guard<std::mutex> lock(workers_mutex_);
  if (cleanup_known) {
    if (active_workers_ > 0) --active_workers_;
  } else {
    // 中文原因：kill/reap 未确认时不能伪造归还 slot，否则会无限接受新 cell。
    cleanup_unknown_ = true;
  }
}

void CellTransport::accept_loop() {
  while (!stop_.load(std::memory_order_acquire)) {
    {
      std::lock_guard<std::mutex> lock(workers_mutex_);
      prune_finished_workers_locked();
    }
    int client_fd = -1;
    std::string error;
    if (!accept_one_with_deadline(listener_fd_, kRelayPollMs, client_fd, error)) {
      if (stop_.load(std::memory_order_acquire)) break;
      if (error == "deadline exceeded") continue;
      break;
    }
    if (!reserve_slot()) {
      (void)send_fixed_error(client_fd, "cell-slot-busy", stop_);
      shutdown_and_close(client_fd);
      continue;
    }
    auto done = std::make_shared<std::atomic<bool>>(false);
    try {
      WorkerRecord record;
      record.done = done;
      record.thread = std::thread([this, client_fd, done] {
        run_worker(client_fd, true);
        done->store(true, std::memory_order_release);
      });
      std::lock_guard<std::mutex> lock(workers_mutex_);
      workers_.push_back(std::move(record));
    } catch (...) {
      done->store(true, std::memory_order_release);
      release_slot(true);
      shutdown_and_close(client_fd);
    }
  }
}

void CellTransport::run_worker(int client_fd, bool reserved_slot) {
  (void)reserved_slot;
  bool cleanup_known = true;
  CellSpawn spawn;
  bool ready_sent = false;
  auto finish = [&]() {
    close_if_needed(spawn.source_write);
    close_if_needed(spawn.request_write);
    close_if_needed(spawn.response_read);
    shutdown_and_close(client_fd);
    release_slot(cleanup_known);
  };

  zody::cua::round11::PeerExpectation expectation;
  expectation.pid = config_.cli_pid;
  expectation.uid = config_.uid;
  expectation.bundle_id = config_.node_loaded_code.identifier;
  expectation.leaf_certificate_sha256 = config_.node_loaded_code.leaf_certificate_sha256;
  expectation.designated_requirement = config_.node_loaded_code.designated_requirement;
  expectation.require_empty_entitlements = true;
  const zody::cua::round11::PeerAuthResult peer =
      zody::cua::round11::authenticate_peer_fd(client_fd, expectation);
  if (!peer.ok || peer.peer_pid != config_.cli_pid) {
    // 中文原因：另一个合法 Node 也不能获得 cell；只接受 Helper 自己 spawn 的 CLI Node。
    finish();
    return;
  }
  // 中文原因：PeerExpectation 只覆盖 bundle/leaf/DR/entitlements，不包含 CDHash；
  // 与 capture authority 一样按连接 peer 的实际 PID 再复核 loaded code，不能因为
  // Helper 启动 CLI 时验过一次就省掉连接时的 actual image 复核。
  const zody::cua::round11::LoadedCodeResult peer_loaded =
      zody::cua::round11::verify_loaded_code_for_pid(peer.peer_pid, config_.node_loaded_code);
  if (!peer_loaded.ok) {
    finish();
    return;
  }
  log_cell_peer_verified(peer.peer_pid, peer_loaded);

  std::string line;
  std::string error;
  if (!read_line_bounded(client_fd, kCellControlMaxFrameBytes, kOpenFrameTimeoutMs, stop_, line,
                         error)) {
    (void)send_fixed_error(client_fd, "cell-open-read-failed", stop_);
    finish();
    return;
  }
  CellOpenRequest open;
  if (!parse_cell_open_line(line, kCellControlMaxFrameBytes, open, error)) {
    (void)send_fixed_error(client_fd, "cell-open-invalid", stop_);
    finish();
    return;
  }
  if (open.source_sha256 != config_.server_sha256) {
    (void)send_fixed_error(client_fd, "cell-source-sha-mismatch", stop_);
    finish();
    return;
  }
  std::string canonical;
  std::string proof;
  std::string auth_error;
  if (!transport_proof_canonical(TransportRole::Cell, open.challenge_hex, open.source_sha256,
                                 open.request_max_bytes, open.response_max_bytes, canonical,
                                 auth_error) ||
      !compute_transport_proof(config_.transport_authentication_key, canonical, proof,
                               auth_error)) {
    (void)send_fixed_error(client_fd, "cell-transport-proof-failed", stop_);
    finish();
    return;
  }

  bool spawn_cleanup_unknown = false;
  if (!spawn_suspended_cell(config_, spawn, error, spawn_cleanup_unknown)) {
    if (spawn_cleanup_unknown) cleanup_known = false;
    (void)send_fixed_error(client_fd, "cell-spawn-failed", stop_);
    finish();
    return;
  }
  log_cell_spawned(spawn.pid, true);
  // 从此刻起必须确认 kill+reap 才能归还 slot。
  cleanup_known = false;

  SuspendedNodeVerification verification;
  if (!verify_suspended_node_then_resume(spawn.pid, config_.node_loaded_code, verification)) {
    log_cell_loaded_code(spawn.pid, verification);
    cleanup_known = verification.reaped;
    log_cell_reaped(spawn.pid, cleanup_known, false, 0);
    (void)send_fixed_error(client_fd, "cell-identity-failed", stop_);
    finish();
    return;
  }
  log_cell_loaded_code(spawn.pid, verification);
  log_cell_resumed(spawn.pid);

  std::string source_error;
  const bool source_written =
      write_all_fd(spawn.source_write, config_.server_source.data(), config_.server_source.size(),
                   kSourceWriteTimeoutMs, stop_, source_error);
  close_if_needed(spawn.source_write);
  if (!source_written) {
    (void)send_fixed_error(client_fd, "cell-source-write-failed", stop_);
    int status = 0;
    bool known = false;
    cleanup_known = kill_and_reap_suspended_node(spawn.pid, kKillReapMs, status, known) && known;
    log_cell_reaped(spawn.pid, cleanup_known, known, status);
    finish();
    return;
  }
  log_cell_source_sent(spawn.pid, config_.server_source.size());

  // 中文原因：实际 PID 身份核验、resume 和 pinned source 之后才发 proof；proof
  // 独立于原 cell-ready，cellPid 不进入 MAC，也不在 proof 前被当作身份。
  const std::string proof_frame =
      serialize_transport_proof(TransportRole::Cell, open.challenge_hex, proof);
  const std::string ready = serialize_cell_ready(spawn.pid);
  if (proof_frame.empty() || ready.empty() ||
      !write_all_fd(client_fd, proof_frame.data(), proof_frame.size(), kReadyWriteTimeoutMs,
                    stop_, error) ||
      !write_all_fd(client_fd, ready.data(), ready.size(), kReadyWriteTimeoutMs, stop_, error)) {
    int status = 0;
    bool known = false;
    cleanup_known = kill_and_reap_suspended_node(spawn.pid, kKillReapMs, status, known) && known;
    log_cell_reaped(spawn.pid, cleanup_known, known, status);
    finish();
    return;
  }
  ready_sent = true;

  CellRelayLimits limits;
  limits.request_max_bytes = open.request_max_bytes;
  limits.response_max_bytes = open.response_max_bytes;
  limits.timeout_ms = config_.relay_timeout_ms;
  std::string relay_error;
  const CellRelayOutcome outcome =
      relay_cell_streams(client_fd, spawn.request_write, spawn.response_read, limits, stop_,
                         relay_error);
  close_if_needed(spawn.request_write);
  close_if_needed(spawn.response_read);

  int wait_status = 0;
  bool wait_known = false;
  if (outcome == CellRelayOutcome::Completed) {
    const bool exited = wait_child(spawn.pid, kExitWaitMs, wait_status, wait_known);
    if (!exited || !wait_known) {
      cleanup_known =
          kill_and_reap_suspended_node(spawn.pid, kKillReapMs, wait_status, wait_known) &&
          wait_known;
    } else {
      cleanup_known = true;
    }
  } else {
    // 中文原因：EOF/abort/超时/越界都不能继续等后代释放 fd4；直接 kill 直接子进程
    // 并有界 reap。清理未确认时 release_slot 会保留 slot，不伪造可继续服务。
    cleanup_known =
        kill_and_reap_suspended_node(spawn.pid, kKillReapMs, wait_status, wait_known) &&
        wait_known;
  }
  log_cell_reaped(spawn.pid, cleanup_known, wait_known, wait_status);

  if (ready_sent && outcome != CellRelayOutcome::ClientEof) {
    const char* reason = nullptr;
    switch (outcome) {
      case CellRelayOutcome::RequestBoundExceeded:
        reason = "cell-request-bound-exceeded";
        break;
      case CellRelayOutcome::ResponseBoundExceeded:
        reason = "cell-response-bound-exceeded";
        break;
      case CellRelayOutcome::TimedOut:
        reason = "cell-relay-timeout";
        break;
      case CellRelayOutcome::Aborted:
        reason = "cell-relay-aborted";
        break;
      case CellRelayOutcome::Stopped:
        reason = "cell-transport-stopping";
        break;
      default:
        break;
    }
    if (reason != nullptr) (void)send_fixed_error(client_fd, reason, stop_);

    bool exited = false;
    bool signaled = false;
    int exit_code = 0;
    int signal_value = 0;
    if (wait_known && WIFEXITED(wait_status)) {
      exited = true;
      exit_code = WEXITSTATUS(wait_status);
    } else if (wait_known && WIFSIGNALED(wait_status)) {
      signaled = true;
      signal_value = WTERMSIG(wait_status);
    }
    const std::string trailer =
        serialize_cell_exit(cleanup_known, exited, exit_code, signaled, signal_value);
    if (!trailer.empty()) {
      std::string ignored;
      (void)write_all_fd(client_fd, trailer.data(), trailer.size(), 2'000, stop_, ignored);
    }
  }
  finish();
}
}  // namespace zody::cua::desktop_session
