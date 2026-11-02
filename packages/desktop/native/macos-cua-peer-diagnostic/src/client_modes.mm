#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include "cli_common.h"
#include "peer_socket.h"
#include "report.h"

namespace {

bool send_partial_frame(int fd, uint32_t declared, size_t send_bytes, int timeout_ms,
                        std::string& error) {
  if (send_bytes > declared || declared == 0 || declared > kMaxRequestBytes) {
    error = "partial frame parameters are invalid";
    return false;
  }
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  std::vector<uint8_t> bytes(4 + send_bytes, 0);
  bytes[0] = static_cast<uint8_t>((declared >> 24) & 0xff);
  bytes[1] = static_cast<uint8_t>((declared >> 16) & 0xff);
  bytes[2] = static_cast<uint8_t>((declared >> 8) & 0xff);
  bytes[3] = static_cast<uint8_t>(declared & 0xff);
  size_t offset = 0;
  while (offset < bytes.size()) {
    if (std::chrono::steady_clock::now() >= deadline) {
      error = "partial frame deadline exceeded";
      return false;
    }
    const ssize_t sent = send(fd, bytes.data() + offset, bytes.size() - offset, MSG_NOSIGNAL);
    if (sent < 0) {
      if (errno == EINTR) {
        continue;
      }
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
        continue;
      }
      error = std::string("partial frame send failed: ") + std::strerror(errno);
      return false;
    }
    offset += static_cast<size_t>(sent);
  }
  return true;
}

}  // namespace

int run_connect(const std::vector<std::string>& args, bool replace, bool partial) {
  Options options;
  std::string error;
  const std::set<std::string> allowed = partial
      ? std::set<std::string>{"--socket", "--declared-bytes", "--send-bytes", "--hold-ms",
                              "--timeout-ms"}
      : replace
        ? std::set<std::string>{"--socket", "--hold-ms", "--timeout-ms"}
        : std::set<std::string>{"--socket", "--timeout-ms"};
  if (!parse_options(args, 2, options, error) || !only_options(options, allowed, error)) {
    emit_client_report(false, 0, "invalid-arguments: " + error);
    return 2;
  }
  std::string socket_path;
  if (!required_option(options, "--socket", socket_path, error)) {
    emit_client_report(false, 0, "socket-missing: " + error);
    return 2;
  }
  long long timeout_ms = kDefaultTimeoutMs;
  long long hold_ms = partial ? 2000 : 500;
  if (!option_int(options, "--timeout-ms", kDefaultTimeoutMs, 100, 300000, timeout_ms, error) ||
      !option_int(options, "--hold-ms", hold_ms, 0, 300000, hold_ms, error)) {
    emit_client_report(false, 0, "invalid-timeout: " + error);
    return 2;
  }
  int fd = -1;
  if (!connect_with_deadline(socket_path, static_cast<int>(timeout_ms), fd, error)) {
    emit_client_report(false, 0, "connect-failed: " + error);
    return 1;
  }

  if (partial) {
    long long declared = 0;
    long long send_bytes = 0;
    if (!option_int(options, "--declared-bytes", 0, 1, 4096, declared, error) ||
        !option_int(options, "--send-bytes", 0, 0, 4096, send_bytes, error) ||
        !send_partial_frame(fd, static_cast<uint32_t>(declared), static_cast<size_t>(send_bytes),
                            static_cast<int>(timeout_ms), error)) {
      close(fd);
      emit_client_report(false, 0, "partial-frame-failed: " + error);
      return 1;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(hold_ms));
    close(fd);
    emit_client_report(true, 0, "partial-frame-sent");
    return 0;
  }

  SocketOwnership replacement;
  int replacement_fd = -1;
  if (replace) {
    if (unlink(socket_path.c_str()) != 0) {
      close(fd);
      emit_client_report(false, 0, "replace-unlink-failed: " + std::string(std::strerror(errno)));
      return 1;
    }
    if (!bind_private_socket(socket_path, replacement_fd, replacement, error) ||
        listen(replacement_fd, 1) != 0) {
      if (replacement_fd >= 0) {
        close_owned_socket(replacement_fd, socket_path, replacement);
      }
      close(fd);
      emit_client_report(false, 0, "replace-bind-failed: " + error);
      return 1;
    }
    emit_ready("replacement-bound", replacement, static_cast<unsigned long long>(hold_ms));
  }

  std::string response;
  if (!write_bounded_frame(fd, kRequest, static_cast<int>(timeout_ms), error) ||
      !read_bounded_frame(fd, kMaxResponseBytes, static_cast<int>(timeout_ms), response, error)) {
    close(fd);
    if (replace) {
      close_owned_socket(replacement_fd, socket_path, replacement);
    }
    emit_client_report(false, 0, "frame-failed: " + error);
    return 1;
  }
  close(fd);
  if (replace) {
    std::this_thread::sleep_for(std::chrono::milliseconds(hold_ms));
    close_owned_socket(replacement_fd, socket_path, replacement);
  }
  emit_client_report(true, static_cast<int>(response.size()), replace ? "replacement-retained" : "");
  return 0;
}

int run_hold_socket(const std::vector<std::string>& args) {
  Options options;
  std::string error;
  if (!parse_options(args, 2, options, error) ||
      !only_options(options, {"--socket", "--hold-ms"}, error)) {
    emit_client_report(false, 0, "invalid-arguments: " + error);
    return 2;
  }
  std::string socket_path;
  long long hold_ms = 5000;
  if (!required_option(options, "--socket", socket_path, error) ||
      !option_int(options, "--hold-ms", hold_ms, 100, 300000, hold_ms, error)) {
    emit_client_report(false, 0, "invalid-arguments: " + error);
    return 2;
  }
  int fd = -1;
  SocketOwnership ownership;
  if (!bind_private_socket(socket_path, fd, ownership, error) || listen(fd, 1) != 0) {
    emit_client_report(false, 0, "hold-bind-failed: " + error);
    return 1;
  }
  emit_ready("holding", ownership, static_cast<unsigned long long>(hold_ms));
  std::this_thread::sleep_for(std::chrono::milliseconds(hold_ms));
  close_owned_socket(fd, socket_path, ownership);
  return 0;
}
