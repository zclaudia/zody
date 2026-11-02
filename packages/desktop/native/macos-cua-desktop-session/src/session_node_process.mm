#include "session_node_process.h"

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstring>
#include <string>
#include <vector>

#include "bundle_paths.h"
#include "session_exit_policy.h"

extern char** environ;

namespace zody::cua::desktop_session {
namespace {

void close_if_needed(int fd) {
  if (fd >= 0) close(fd);
}

enum class WaitOutcome { Reaped, Running, Error };

WaitOutcome poll_wait_status(pid_t pid, int& error_number, int* status_out) {
  int status = 0;
  const pid_t result = waitpid(pid, &status, WNOHANG);
  if (result == pid) {
    if (status_out != nullptr) *status_out = status;
    return WaitOutcome::Reaped;
  }
  if (result == 0) return WaitOutcome::Running;
  if (result < 0 && errno == EINTR) return WaitOutcome::Running;
  error_number = errno;
  return WaitOutcome::Error;
}

WaitOutcome wait_for_exit(pid_t pid, int timeout_ms, int& error_number, int* status_out) {
  for (int elapsed = 0; elapsed < timeout_ms; elapsed += 20) {
    const WaitOutcome outcome = poll_wait_status(pid, error_number, status_out);
    if (outcome != WaitOutcome::Running) return outcome;
    usleep(20'000);
  }
  return WaitOutcome::Running;
}

std::string format_wait_status(int status) {
  if (WIFEXITED(status)) {
    return "exit-code=" + std::to_string(WEXITSTATUS(status));
  }
  if (WIFSIGNALED(status)) {
    return "signal=" + std::to_string(WTERMSIG(status));
  }
  return "raw-status=" + std::to_string(status);
}

bool blocked_environment(const char* entry) {
  static const char* prefixes[] = {
      "DYLD_", "LD_", "NODE_OPTIONS=", "NODE_PATH=", "NODE_REPL_",
      "ELECTRON_RUN_AS_NODE=", "NODE_EXTRA_CA_CERTS=",
  };
  for (const char* prefix : prefixes) {
    if (std::strncmp(entry, prefix, std::strlen(prefix)) == 0) return true;
  }
  return false;
}

std::vector<std::string> child_environment() {
  std::vector<std::string> result;
  for (char** entry = environ; entry != nullptr && *entry != nullptr; ++entry) {
    if (blocked_environment(*entry)) continue;
    result.emplace_back(*entry);
  }
  return result;
}

bool write_snapshot(int fd, const std::string& bytes, std::string& error) {
  if (fcntl(fd, F_SETFL, O_NONBLOCK) != 0) {
    error = std::string("cannot set authority stdin nonblocking: ") + std::strerror(errno);
    return false;
  }
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(10'000);
  size_t written = 0;
  while (written < bytes.size()) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                               deadline - std::chrono::steady_clock::now())
                               .count();
    if (remaining <= 0) {
      error = "sealed snapshot write timed out";
      return false;
    }
    struct pollfd descriptor {};
    descriptor.fd = fd;
    descriptor.events = POLLOUT;
    const int ready = poll(&descriptor, 1, static_cast<int>(remaining));
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
      error = "sealed snapshot pipe is no longer writable";
      return false;
    }
    const ssize_t count = write(fd, bytes.data() + written, bytes.size() - written);
    if (count < 0) {
      if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue;
      error = std::string("sealed snapshot write failed: ") + std::strerror(errno);
      return false;
    }
    if (count == 0) {
      error = "sealed snapshot write made no progress";
      return false;
    }
    written += static_cast<size_t>(count);
  }
  return true;
}

}  // namespace

std::vector<std::string> filtered_node_environment() { return child_environment(); }

bool kill_and_reap_suspended_node(pid_t pid, int timeout_ms, int& wait_status,
                                  bool& wait_status_known) {
  wait_status_known = false;
  if (pid <= 0) return false;
  (void)kill(pid, SIGKILL);
  int error_number = 0;
  const WaitOutcome outcome = wait_for_exit(pid, timeout_ms, error_number, &wait_status);
  if (outcome == WaitOutcome::Reaped) {
    wait_status_known = true;
    return true;
  }
  return false;
}

bool verify_suspended_node_then_resume(
    pid_t pid, const zody::cua::round11::LoadedCodeExpectation& loaded_code,
    SuspendedNodeVerification& verification) {
  verification = SuspendedNodeVerification();
  if (pid <= 0) {
    verification.reason = "invalid-child-pid";
    return false;
  }
  // 中文原因：只有 posix_spawn 返回的真实 child PID 才能证明“实际加载的映像”；
  // 不能改用 node_path、argv 或 entry 自报 PID。核验发生在 SIGCONT 之前。
  const zody::cua::round11::LoadedCodeResult loaded =
      zody::cua::round11::verify_loaded_code_for_pid(pid, loaded_code);
  verification.loaded_identifier = loaded.identifier;
  verification.loaded_cdhash_hex = loaded.cdhash_hex;
  verification.loaded_leaf_sha256 = loaded.leaf_sha256;
  verification.entitlements_empty = loaded.entitlements_empty;
  if (!loaded.ok) {
    verification.reason = "loaded-code-invalid: " + loaded.reason;
    int status = 0;
    bool status_known = false;
    verification.reaped =
        kill_and_reap_suspended_node(pid, 2'000, status, status_known);
    return false;
  }
  if (kill(pid, SIGCONT) != 0) {
    const int failure = errno;
    verification.reason = std::string("resume-failed: ") + std::strerror(failure);
    int status = 0;
    bool status_known = false;
    verification.reaped =
        kill_and_reap_suspended_node(pid, 2'000, status, status_known);
    return false;
  }
  verification.verified = true;
  verification.resumed = true;
  return true;
}

SessionNode::~SessionNode() { stop(); }

SessionNode::SessionNode(SessionNode&& other) noexcept
    : pid(other.pid),
      control_fd(other.control_fd),
      reaped(other.reaped),
      cleanup_pending(other.cleanup_pending),
      wait_status(other.wait_status),
      wait_status_known(other.wait_status_known),
      termination_signal_sent(other.termination_signal_sent) {
  other.pid = -1;
  other.control_fd = -1;
}

SessionNode& SessionNode::operator=(SessionNode&& other) noexcept {
  if (this != &other) {
    stop();
    pid = other.pid;
    control_fd = other.control_fd;
    reaped = other.reaped;
    cleanup_pending = other.cleanup_pending;
    wait_status = other.wait_status;
    wait_status_known = other.wait_status_known;
    termination_signal_sent = other.termination_signal_sent;
    other.pid = -1;
    other.control_fd = -1;
  }
  return *this;
}

void SessionNode::close_control() {
  close_if_needed(control_fd);
  control_fd = -1;
}

void SessionNode::observe_exit() {
  if (pid <= 0 || reaped) return;
  int error_number = 0;
  const WaitOutcome outcome = poll_wait_status(pid, error_number, &wait_status);
  if (outcome == WaitOutcome::Reaped) {
    wait_status_known = true;
    reaped = true;
    cleanup_pending = false;
  } else if (outcome == WaitOutcome::Error && error_number == ECHILD) {
    cleanup_pending = true;
  }
}

bool SessionNode::wait_for_exit_status(int timeout_ms) {
  observe_exit();
  if (reaped || pid <= 0) return wait_status_known;
  int error_number = 0;
  const WaitOutcome outcome = wait_for_exit(pid, timeout_ms, error_number, &wait_status);
  if (outcome == WaitOutcome::Reaped) {
    wait_status_known = true;
    reaped = true;
    cleanup_pending = false;
    return true;
  }
  if (outcome == WaitOutcome::Error && error_number == ECHILD) cleanup_pending = true;
  return false;
}

std::string SessionNode::wait_status_text() const {
  if (!wait_status_known) return "child-status-unavailable";
  std::string text = format_wait_status(wait_status);
  if (termination_signal_sent) text += " (native sent a termination signal)";
  return text;
}

bool SessionNode::exited_cleanly() const {
  return wait_status_known && exit_status_is_clean(wait_status);
}

void SessionNode::stop() {
  close_control();
  if (pid <= 0 || reaped) return;
  int error_number = 0;
  WaitOutcome outcome = wait_for_exit(pid, 1'000, error_number, &wait_status);
  if (outcome == WaitOutcome::Reaped) {
    wait_status_known = true;
    reaped = true;
    cleanup_pending = false;
    return;
  }
  if (outcome == WaitOutcome::Error && error_number == ECHILD) {
    cleanup_pending = true;
    return;
  }
  (void)kill(pid, SIGTERM);
  termination_signal_sent = true;
  error_number = 0;
  outcome = wait_for_exit(pid, 1'000, error_number, &wait_status);
  if (outcome == WaitOutcome::Reaped) {
    wait_status_known = true;
    reaped = true;
    cleanup_pending = false;
    return;
  }
  if (outcome == WaitOutcome::Error && error_number == ECHILD) {
    cleanup_pending = true;
    return;
  }
  (void)kill(pid, SIGKILL);
  error_number = 0;
  outcome = wait_for_exit(pid, 1'000, error_number, &wait_status);
  if (outcome == WaitOutcome::Reaped) {
    wait_status_known = true;
    reaped = true;
    cleanup_pending = false;
    return;
  }
  cleanup_pending = true;
}

bool launch_session_node(const std::string& node_path, int node_fd,
                         const std::string& sealed_js,
                         const zody::cua::round11::LoadedCodeExpectation& loaded_code,
                         const SessionNodeFds& fds, SessionNode& node, std::string& error) {
  if (node_fd < 0 || sealed_js.empty()) {
    error = "verified node or sealed snapshot is unavailable";
    return false;
  }
  if (!zody::cua::round11::verify_path_matches_fd(node_path, node_fd, error)) return false;

  int control[2] = {-1, -1};
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, control) != 0) {
    error = std::string("control socketpair failed: ") + std::strerror(errno);
    return false;
  }
  int stdin_pipe[2] = {-1, -1};
  if (pipe(stdin_pipe) != 0) {
    close(control[0]);
    close(control[1]);
    error = std::string("stdin pipe failed: ") + std::strerror(errno);
    return false;
  }

  const int pipe_read = fcntl(stdin_pipe[0], F_DUPFD_CLOEXEC, 10);
  const int pipe_write = fcntl(stdin_pipe[1], F_DUPFD_CLOEXEC, 10);
  close(stdin_pipe[0]);
  close(stdin_pipe[1]);
  const int parent_control = fcntl(control[0], F_DUPFD_CLOEXEC, 10);
  close(control[0]);
  const int child_control = fcntl(control[1], F_DUPFD_CLOEXEC, 10);
  close(control[1]);
  if (pipe_read < 0 || pipe_write < 0 || parent_control < 0 || child_control < 0) {
    const int failure = errno;
    close_if_needed(pipe_read);
    close_if_needed(pipe_write);
    close_if_needed(parent_control);
    close_if_needed(child_control);
    error = std::string("fd normalization failed: ") + std::strerror(failure);
    return false;
  }

  const int host_source =
      fds.host_bridge_fd >= 0 ? fcntl(fds.host_bridge_fd, F_DUPFD_CLOEXEC, 10) : -1;
  const int cli_in_source =
      fds.cli_input_fd >= 0 ? fcntl(fds.cli_input_fd, F_DUPFD_CLOEXEC, 10) : -1;
  const int cli_out_source =
      fds.cli_output_fd >= 0 ? fcntl(fds.cli_output_fd, F_DUPFD_CLOEXEC, 10) : -1;
  if ((fds.host_bridge_fd >= 0 && host_source < 0) ||
      (fds.cli_input_fd >= 0 && cli_in_source < 0) ||
      (fds.cli_output_fd >= 0 && cli_out_source < 0)) {
    const int failure = errno;
    close_if_needed(pipe_read);
    close_if_needed(pipe_write);
    close_if_needed(parent_control);
    close_if_needed(child_control);
    close_if_needed(host_source);
    close_if_needed(cli_in_source);
    close_if_needed(cli_out_source);
    error = std::string("channel fd normalization failed: ") + std::strerror(failure);
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
  if (status == 0) status = posix_spawn_file_actions_adddup2(&actions, pipe_read, STDIN_FILENO);
  if (status == 0) status = posix_spawn_file_actions_adddup2(&actions, child_control, 3);
  // 中文原因：POSIX_SPAWN_CLOEXEC_DEFAULT 会隐式关闭未显式保留的 fd；必须显式
  // 继承 stdout/stderr，否则无 JIT entitlement/加载失败时子进程日志完全不可见。
  if (status == 0) status = posix_spawn_file_actions_adddup2(&actions, STDOUT_FILENO, STDOUT_FILENO);
  if (status == 0) status = posix_spawn_file_actions_adddup2(&actions, STDERR_FILENO, STDERR_FILENO);
  if (status == 0 && host_source >= 0)
    status = posix_spawn_file_actions_adddup2(&actions, host_source, 5);
  if (status == 0 && cli_in_source >= 0)
    status = posix_spawn_file_actions_adddup2(&actions, cli_in_source, 6);
  if (status == 0 && cli_out_source >= 0)
    status = posix_spawn_file_actions_adddup2(&actions, cli_out_source, 7);
  if (status == 0) status = posix_spawn_file_actions_addclose(&actions, pipe_read);
  if (status == 0) status = posix_spawn_file_actions_addclose(&actions, child_control);
  if (status == 0 && host_source >= 0)
    status = posix_spawn_file_actions_addclose(&actions, host_source);
  if (status == 0 && cli_in_source >= 0)
    status = posix_spawn_file_actions_addclose(&actions, cli_in_source);
  if (status == 0 && cli_out_source >= 0)
    status = posix_spawn_file_actions_addclose(&actions, cli_out_source);
  if (status == 0) status = posix_spawn_file_actions_addclose(&actions, parent_control);
  // 中文原因：旧实现先让 child 运行、再按 PID 复核 loaded code，wrapper fork/exec
  // 的合法 Node 可在核验前执行。现在从创建起就 STOP，核验成功后才 SIGCONT。
  if (status == 0)
    status = posix_spawnattr_setflags(
        &attributes, POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_START_SUSPENDED);
  if (status != 0) {
    // 中文原因：attr 初始化失败时不能 destroy 未初始化对象。
    if (actions_ready) posix_spawn_file_actions_destroy(&actions);
    if (attributes_ready) posix_spawnattr_destroy(&attributes);
    close_if_needed(pipe_read);
    close_if_needed(pipe_write);
    close_if_needed(parent_control);
    close_if_needed(child_control);
    close_if_needed(host_source);
    close_if_needed(cli_in_source);
    close_if_needed(cli_out_source);
    error = std::string("posix_spawn setup failed: ") + std::strerror(status);
    return false;
  }

  char* argv[] = {
      const_cast<char*>(node_path.c_str()),
      const_cast<char*>("--jitless"),
      const_cast<char*>("--no-warnings"),
      const_cast<char*>("--input-type=module"),
      nullptr,
  };
  std::vector<std::string> environment = child_environment();
  std::vector<char*> envp;
  envp.reserve(environment.size() + 1);
  for (std::string& entry : environment) envp.push_back(entry.data());
  envp.push_back(nullptr);

  pid_t pid = -1;
  const int spawn_status =
      posix_spawn(&pid, node_path.c_str(), &actions, &attributes, argv, envp.data());
  if (actions_ready) posix_spawn_file_actions_destroy(&actions);
  if (attributes_ready) posix_spawnattr_destroy(&attributes);
  close_if_needed(pipe_read);
  close_if_needed(child_control);
  close_if_needed(host_source);
  close_if_needed(cli_in_source);
  close_if_needed(cli_out_source);

  if (spawn_status != 0) {
    close_if_needed(pipe_write);
    close_if_needed(parent_control);
    error = std::string("posix_spawn failed: ") + std::strerror(spawn_status);
    return false;
  }

  // 中文原因：必须先在真实 child PID 上完成 loaded-code/entitlement 校验并恢复，
  // 再把可信 sealed JS 写进 stdin；否则未验证进程会先获得可执行输入。
  SuspendedNodeVerification verification;
  if (!verify_suspended_node_then_resume(pid, loaded_code, verification)) {
    close_if_needed(pipe_write);
    close_if_needed(parent_control);
    error = "node loaded-code verification failed: " + verification.reason;
    return false;
  }

  std::string write_error;
  if (!write_snapshot(pipe_write, sealed_js, write_error)) {
    close_if_needed(pipe_write);
    close_if_needed(parent_control);
    int status_value = 0;
    bool status_known = false;
    (void)kill_and_reap_suspended_node(pid, 2'000, status_value, status_known);
    error = write_error;
    return false;
  }
  close_if_needed(pipe_write);

  node.pid = pid;
  node.control_fd = parent_control;
  return true;
}

}  // namespace zody::cua::desktop_session
