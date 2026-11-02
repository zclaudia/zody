#include "node_process.h"

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

#include "bundle_paths.h"

namespace zody::cua::round11 {
namespace {

void close_if_needed(int fd) {
  if (fd >= 0) close(fd);
}

enum class WaitOutcome { Reaped, Running, Error };

WaitOutcome observe_exit(pid_t pid, int& error_number) {
  int status = 0;
  const pid_t result = waitpid(pid, &status, WNOHANG);
  if (result == pid) return WaitOutcome::Reaped;
  if (result == 0) return WaitOutcome::Running;
  if (result < 0 && errno == EINTR) return WaitOutcome::Running;
  error_number = errno;
  return WaitOutcome::Error;
}

WaitOutcome wait_for_exit(pid_t pid, int timeout_ms, int& error_number) {
  for (int elapsed = 0; elapsed < timeout_ms; elapsed += 20) {
    const WaitOutcome outcome = observe_exit(pid, error_number);
    if (outcome != WaitOutcome::Running) return outcome;
    usleep(20'000);
  }
  return WaitOutcome::Running;
}

}  // namespace

AuthorityNode::~AuthorityNode() { stop(); }

AuthorityNode::AuthorityNode(AuthorityNode&& other) noexcept
    : pid(other.pid),
      authority_fd(other.authority_fd),
      reaped(other.reaped),
      cleanup_pending(other.cleanup_pending) {
  other.pid = -1;
  other.authority_fd = -1;
}

AuthorityNode& AuthorityNode::operator=(AuthorityNode&& other) noexcept {
  if (this != &other) {
    stop();
    pid = other.pid;
    authority_fd = other.authority_fd;
    reaped = other.reaped;
    cleanup_pending = other.cleanup_pending;
    other.pid = -1;
    other.authority_fd = -1;
  }
  return *this;
}

void AuthorityNode::close_authority() {
  close_if_needed(authority_fd);
  authority_fd = -1;
}

int AuthorityNode::release_authority_fd() {
  const int fd = authority_fd;
  authority_fd = -1;
  return fd;
}

void AuthorityNode::stop() {
  close_authority();
  if (pid <= 0 || reaped) return;
  // 对照 Node FD3 EOF 的 producerLost：先关控制 fd，再等待，最后才 kill。
  int error_number = 0;
  WaitOutcome outcome = wait_for_exit(pid, 1'000, error_number);
  if (outcome == WaitOutcome::Reaped) {
    reaped = true;
    pid = -1;
    cleanup_pending = false;
    return;
  }
  // 中文原因：ECHILD 表示该 pid 已被回收，进程号可能已被复用；此时再发
  // signal 会打到无关进程，所以立即停止 kill，并保留“未确认”的清理事实。
  if (outcome == WaitOutcome::Error && error_number == ECHILD) {
    cleanup_pending = true;
    return;
  }
  (void)kill(pid, SIGTERM);
  error_number = 0;
  outcome = wait_for_exit(pid, 1'000, error_number);
  if (outcome == WaitOutcome::Reaped) {
    reaped = true;
    pid = -1;
    cleanup_pending = false;
    return;
  }
  if (outcome == WaitOutcome::Error && error_number == ECHILD) {
    cleanup_pending = true;
    return;
  }
  (void)kill(pid, SIGKILL);
  error_number = 0;
  outcome = wait_for_exit(pid, 1'000, error_number);
  if (outcome == WaitOutcome::Reaped) {
    reaped = true;
    pid = -1;
    cleanup_pending = false;
    return;
  }
  // 未确认回收时不能把 pid=-1 当成已清理，否则后续可能重复向错误对象宣称
  // stop 完成。保留 pid 与 pending 事实，交给上层按隔离/未知处理。
  cleanup_pending = true;
}

bool launch_authority_node(const std::string& node_path, int node_fd,
                           const std::string& authority_js_snapshot,
                           const LoadedCodeExpectation& loaded_code, AuthorityNode& node,
                           std::string& error) {
  if (node_fd < 0 || authority_js_snapshot.empty()) {
    error = "verified node or authority snapshot is unavailable";
    return false;
  }
  if (!verify_path_matches_fd(node_path, node_fd, error)) {
    return false;
  }

  int sockets[2] = {-1, -1};
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) != 0) {
    error = std::string("socketpair failed: ") + std::strerror(errno);
    return false;
  }
  int stdin_pipe[2] = {-1, -1};
  if (pipe(stdin_pipe) != 0) {
    close(sockets[0]);
    close(sockets[1]);
    error = std::string("stdin pipe failed: ") + std::strerror(errno);
    return false;
  }
  const int pipe_read = fcntl(stdin_pipe[0], F_DUPFD_CLOEXEC, 10);
  const int pipe_write = fcntl(stdin_pipe[1], F_DUPFD_CLOEXEC, 10);
  close(stdin_pipe[0]);
  close(stdin_pipe[1]);
  const int parent_socket = fcntl(sockets[0], F_DUPFD_CLOEXEC, 10);
  close(sockets[0]);
  if (pipe_read < 0 || pipe_write < 0 || parent_socket < 0) {
    const int failure = errno;
    close_if_needed(pipe_read);
    close_if_needed(pipe_write);
    close_if_needed(parent_socket);
    close(sockets[1]);
    error = std::string("stdin pipe normalization failed: ") + std::strerror(failure);
    return false;
  }

  // 中文原因：源 fd 可能恰好是 0/3；若先 dup 到 3 再 close 源 fd，会关闭刚
  // 建立的控制通道。统一复制到 >=10 的高 fd，再 dup2 到 0/3，最后只关闭高 fd。
  const int socket_source = fcntl(sockets[1], F_DUPFD_CLOEXEC, 10);
  if (socket_source < 0) {
    const int failure = errno;
    close(pipe_read);
    close(pipe_write);
    close(parent_socket);
    close(sockets[1]);
    error = std::string("fd normalization failed: ") + std::strerror(failure);
    return false;
  }

  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  int action_status = posix_spawn_file_actions_init(&actions);
  if (action_status == 0) action_status = posix_spawnattr_init(&attributes);
  if (action_status == 0)
    action_status = posix_spawn_file_actions_adddup2(&actions, pipe_read, STDIN_FILENO);
  if (action_status == 0)
    action_status = posix_spawn_file_actions_adddup2(&actions, socket_source, 3);
  if (action_status == 0)
    action_status = posix_spawn_file_actions_addclose(&actions, pipe_read);
  if (action_status == 0)
    action_status = posix_spawn_file_actions_addclose(&actions, socket_source);
  if (action_status == 0)
    action_status = posix_spawn_file_actions_addclose(&actions, parent_socket);
  if (action_status == 0)
    action_status = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT);
  if (action_status != 0) {
    posix_spawn_file_actions_destroy(&actions);
    posix_spawnattr_destroy(&attributes);
    close(pipe_read);
    close(pipe_write);
    close(parent_socket);
    close(socket_source);
    close(sockets[1]);
    error = std::string("posix_spawn setup failed: ") + std::strerror(action_status);
    return false;
  }

  char* argv[] = {
      const_cast<char*>(node_path.c_str()),
      const_cast<char*>("--jitless"),
      const_cast<char*>("--no-warnings"),
      const_cast<char*>("--input-type=module"),
      nullptr,
  };
  char* envp[] = {
      const_cast<char*>("PATH=/usr/bin:/bin"),
      const_cast<char*>("LANG=C"),
      const_cast<char*>("LC_ALL=C"),
      nullptr,
  };

  pid_t pid = -1;
  const int spawn_status =
      posix_spawn(&pid, node_path.c_str(), &actions, &attributes, argv, envp);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attributes);
  close(pipe_read);
  close(socket_source);
  close(sockets[1]);

  if (spawn_status != 0) {
    close(pipe_write);
    close(parent_socket);
    error = std::string("posix_spawn failed: ") + std::strerror(spawn_status);
    return false;
  }

  // 中文原因：Node 可能提前退出而不再读 stdin。阻塞 write 会挂死，EPIPE 还
  // 可能触发 SIGPIPE；这里用非阻塞 fd + 有界 poll，失败后直接回收子进程。
  if (fcntl(pipe_write, F_SETFL, O_NONBLOCK) != 0) {
    close(pipe_write);
    close(parent_socket);
    (void)kill(pid, SIGKILL);
    (void)waitpid(pid, nullptr, 0);
    error = std::string("cannot set authority stdin nonblocking: ") + std::strerror(errno);
    return false;
  }
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(10'000);
  size_t written = 0;
  while (written < authority_js_snapshot.size()) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                               deadline - std::chrono::steady_clock::now())
                               .count();
    if (remaining <= 0) {
      close(pipe_write);
      close(parent_socket);
      (void)kill(pid, SIGKILL);
      (void)waitpid(pid, nullptr, 0);
      error = "authority snapshot write timed out";
      return false;
    }
    struct pollfd descriptor {};
    descriptor.fd = pipe_write;
    descriptor.events = POLLOUT;
    const int ready = poll(&descriptor, 1, static_cast<int>(remaining));
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
      close(pipe_write);
      close(parent_socket);
      (void)kill(pid, SIGKILL);
      (void)waitpid(pid, nullptr, 0);
      error = "authority snapshot pipe is no longer writable";
      return false;
    }
    const ssize_t count =
        write(pipe_write, authority_js_snapshot.data() + written,
              authority_js_snapshot.size() - written);
    if (count < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
      close(pipe_write);
      close(parent_socket);
      (void)kill(pid, SIGKILL);
      (void)waitpid(pid, nullptr, 0);
      error = std::string("authority snapshot write failed: ") + std::strerror(errno);
      return false;
    }
    if (count == 0) {
      close(pipe_write);
      close(parent_socket);
      (void)kill(pid, SIGKILL);
      (void)waitpid(pid, nullptr, 0);
      error = "authority snapshot write made no progress";
      return false;
    }
    written += static_cast<size_t>(count);
  }
  close(pipe_write);

  LoadedCodeResult loaded = verify_loaded_code_for_pid(pid, loaded_code);
  if (!loaded.ok) {
    close(parent_socket);
    (void)kill(pid, SIGKILL);
    (void)waitpid(pid, nullptr, 0);
    error = "node loaded-code verification failed: " + loaded.reason;
    return false;
  }

  node.pid = pid;
  node.authority_fd = parent_socket;
  return true;
}

}  // namespace zody::cua::round11
