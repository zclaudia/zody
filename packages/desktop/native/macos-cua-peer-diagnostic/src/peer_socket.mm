#include "peer_socket.h"

#include <arpa/inet.h>
#include <bsm/libbsm.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <chrono>
#include <cstddef>
#include <cstring>
#include <string>
#include <thread>

namespace peer_internal {

constexpr int kConnectRetryMs = 20;

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

bool contains_forbidden_bytes(const std::string& value) {
  return value.find('\0') != std::string::npos || value.find('\n') != std::string::npos ||
         value.find('\r') != std::string::npos;
}

bool set_nonblocking(int fd, std::string& error) {
  const int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0) {
    error = std::string("cannot set nonblocking mode: ") + std::strerror(errno);
    return false;
  }
  return true;
}

bool wait_fd(int fd, short events, int64_t deadline, std::string& error) {
  while (true) {
    const int64_t remaining = deadline - now_ms();
    if (remaining <= 0) {
      error = "deadline exceeded";
      return false;
    }
    pollfd entry{fd, events, 0};
    const int result = poll(&entry, 1, static_cast<int>(remaining));
    if (result > 0) {
      if ((entry.revents & events) != 0) {
        return true;
      }
      error = "socket closed or failed while waiting";
      return false;
    }
    if (result == 0) {
      error = "deadline exceeded";
      return false;
    }
    if (errno != EINTR) {
      error = std::string("poll failed: ") + std::strerror(errno);
      return false;
    }
  }
}

bool wait_writable_or_error(int fd, int64_t deadline, std::string& error) {
  while (true) {
    const int64_t remaining = deadline - now_ms();
    if (remaining <= 0) {
      error = "deadline exceeded";
      return false;
    }
    pollfd entry{fd, POLLOUT, 0};
    const int result = poll(&entry, 1, static_cast<int>(remaining));
    if (result > 0) {
      if ((entry.revents & (POLLOUT | POLLERR | POLLHUP)) != 0) {
        return true;
      }
      error = "socket failed while connecting";
      return false;
    }
    if (result == 0) {
      error = "deadline exceeded";
      return false;
    }
    if (errno != EINTR) {
      error = std::string("poll failed: ") + std::strerror(errno);
      return false;
    }
  }
}

bool fill_bound_address(const std::string& socket_path, sockaddr_un& address, std::string& error) {
  if (socket_path.empty() || contains_forbidden_bytes(socket_path) ||
      socket_path.size() >= sizeof(address.sun_path)) {
    error = "AF_UNIX socket path is empty, unsafe or too long";
    return false;
  }
  address = {};
  address.sun_family = AF_UNIX;
  address.sun_len = static_cast<uint8_t>(offsetof(sockaddr_un, sun_path) + socket_path.size() + 1);
  std::memcpy(address.sun_path, socket_path.c_str(), socket_path.size() + 1);
  return true;
}

void unlink_if_owned(const std::string& path, const SocketOwnership& ownership) {
  if (!ownership.valid) {
    return;
  }
  // 中文原因：清理与 bind 路径之间可能发生路径替换竞态。只删除 dev/ino/uid 均与
  // 本次 bind 后记录一致的 socket；替换者或预先存在的同 UID socket 一律保留。
  struct stat info {};
  if (lstat(path.c_str(), &info) == 0 && S_ISSOCK(info.st_mode) &&
      info.st_uid == ownership.uid && info.st_dev == ownership.device &&
      info.st_ino == ownership.inode) {
    unlink(path.c_str());
  }
}

bool record_ownership(const std::string& path, SocketOwnership& ownership, std::string& error) {
  struct stat info {};
  if (lstat(path.c_str(), &info) != 0) {
    error = std::string("cannot stat bound socket: ") + std::strerror(errno);
    return false;
  }
  if (!S_ISSOCK(info.st_mode) || info.st_uid != geteuid()) {
    error = "bound path is not an owned socket";
    return false;
  }
  ownership.device = info.st_dev;
  ownership.inode = info.st_ino;
  ownership.uid = info.st_uid;
  ownership.valid = true;
  return true;
}

}  // namespace

using namespace peer_internal;

bool validate_private_workdir(const std::string& workdir, std::string& error) {
  if (workdir.empty() || workdir[0] != '/') {
    error = "workdir must be an absolute path";
    return false;
  }
  if (contains_forbidden_bytes(workdir)) {
    error = "workdir contains NUL or newline";
    return false;
  }
  struct stat info {};
  if (lstat(workdir.c_str(), &info) != 0) {
    error = std::string("cannot stat workdir: ") + std::strerror(errno);
    return false;
  }
  if (!S_ISDIR(info.st_mode) || S_ISLNK(info.st_mode)) {
    error = "workdir must be a real directory, not a symlink";
    return false;
  }
  if (info.st_uid != geteuid()) {
    error = "workdir must be owned by the current effective user";
    return false;
  }
  if ((info.st_mode & 0777) != 0700) {
    error = "workdir must have mode 0700";
    return false;
  }
  if (peer_socket_path(workdir).size() >= sizeof(sockaddr_un{}.sun_path)) {
    error = "AF_UNIX socket path is too long";
    return false;
  }
  return true;
}

std::string peer_socket_path(const std::string& workdir) {
  if (workdir.size() > 1 && workdir.back() == '/') {
    return workdir.substr(0, workdir.size() - 1) + "/peer.sock";
  }
  return workdir + "/peer.sock";
}

bool bind_private_socket(const std::string& socket_path, int& fd, SocketOwnership& ownership,
                         std::string& error) {
  fd = -1;
  ownership = {};
  struct stat existing {};
  if (lstat(socket_path.c_str(), &existing) == 0) {
    error = "socket path already exists; refusing to reuse it";
    return false;
  }
  if (errno != ENOENT) {
    error = std::string("cannot inspect socket path: ") + std::strerror(errno);
    return false;
  }
  sockaddr_un address{};
  if (!fill_bound_address(socket_path, address, error)) {
    return false;
  }
  const int socket_fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (socket_fd < 0) {
    error = std::string("socket failed: ") + std::strerror(errno);
    return false;
  }
  const int no_sigpipe = 1;
  (void)setsockopt(socket_fd, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe));
  if (!set_nonblocking(socket_fd, error)) {
    close(socket_fd);
    return false;
  }
  const mode_t previous_umask = umask(077);
  const int bind_result = bind(socket_fd, reinterpret_cast<sockaddr*>(&address), sizeof(address));
  umask(previous_umask);
  if (bind_result != 0) {
    error = std::string("bind failed: ") + std::strerror(errno);
    close(socket_fd);
    return false;
  }
  if (!record_ownership(socket_path, ownership, error)) {
    close(socket_fd);
    return false;
  }
  if (chmod(socket_path.c_str(), 0600) != 0) {
    error = std::string("chmod socket failed: ") + std::strerror(errno);
    close(socket_fd);
    // 中文原因：bind 成功后先记录 dev/ino/uid，再执行 chmod；失败清理只能走同一
    // ownership 校验，不能无条件 unlink 可能已被替换的路径。
    unlink_if_owned(socket_path, ownership);
    return false;
  }
  fd = socket_fd;
  return true;
}

bool create_private_listener(const std::string& socket_path, int& listener_fd,
                             SocketOwnership& ownership, std::string& error) {
  if (!bind_private_socket(socket_path, listener_fd, ownership, error)) {
    return false;
  }
  if (listen(listener_fd, 1) != 0) {
    error = std::string("listen failed: ") + std::strerror(errno);
    close_owned_socket(listener_fd, socket_path, ownership);
    listener_fd = -1;
    return false;
  }
  return true;
}

bool accept_one_with_deadline(int listener_fd, int timeout_ms, int& client_fd, std::string& error) {
  client_fd = -1;
  const int64_t deadline = now_ms() + timeout_ms;
  while (true) {
    if (now_ms() >= deadline) {
      error = "deadline exceeded";
      return false;
    }
    const int accepted = accept(listener_fd, nullptr, nullptr);
    if (accepted >= 0) {
      if (!set_nonblocking(accepted, error)) {
        close(accepted);
        return false;
      }
      client_fd = accepted;
      return true;
    }
    if (errno == EINTR) {
      continue;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      if (!wait_fd(listener_fd, POLLIN, deadline, error)) {
        return false;
      }
      continue;
    }
    error = std::string("accept failed: ") + std::strerror(errno);
    return false;
  }
}

bool connect_with_deadline(const std::string& socket_path, int timeout_ms, int& fd,
                           std::string& error) {
  fd = -1;
  sockaddr_un address{};
  if (!fill_bound_address(socket_path, address, error)) {
    return false;
  }
  const int64_t deadline = now_ms() + timeout_ms;
  while (true) {
    if (now_ms() >= deadline) {
      error = "deadline exceeded";
      return false;
    }
    const int socket_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (socket_fd < 0) {
      error = std::string("socket failed: ") + std::strerror(errno);
      return false;
    }
    const int no_sigpipe = 1;
    (void)setsockopt(socket_fd, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe));
    if (!set_nonblocking(socket_fd, error)) {
      close(socket_fd);
      return false;
    }
    const int result = connect(socket_fd, reinterpret_cast<sockaddr*>(&address), sizeof(address));
    if (result == 0) {
      fd = socket_fd;
      return true;
    }
    if (errno == EINPROGRESS) {
      if (!wait_writable_or_error(socket_fd, deadline, error)) {
        close(socket_fd);
        return false;
      }
      int socket_error = 0;
      socklen_t length = sizeof(socket_error);
      if (getsockopt(socket_fd, SOL_SOCKET, SO_ERROR, &socket_error, &length) == 0 &&
          socket_error == 0) {
        fd = socket_fd;
        return true;
      }
      error = std::string("connect failed: ") + std::strerror(socket_error);
    } else if (errno != ENOENT && errno != ECONNREFUSED && errno != EAGAIN &&
               errno != EWOULDBLOCK) {
      error = std::string("connect failed: ") + std::strerror(errno);
      close(socket_fd);
      return false;
    }
    close(socket_fd);
    if (now_ms() + kConnectRetryMs >= deadline) {
      error = "connect deadline exceeded";
      return false;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(kConnectRetryMs));
  }
}

void close_owned_socket(int fd, const std::string& socket_path, const SocketOwnership& ownership) {
  if (fd >= 0) {
    close(fd);
  }
  peer_internal::unlink_if_owned(socket_path, ownership);
}
