#include "peer_socket.h"

#include <bsm/libbsm.h>
#include <errno.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cstdint>
#include <cstring>
#include <string>

#include "peer_internal.h"

namespace {

constexpr size_t kMaxFrameBytes = 64 * 1024;

bool read_exact(int fd, void* buffer, size_t length, int64_t deadline, std::string& error) {
  auto* bytes = static_cast<uint8_t*>(buffer);
  size_t offset = 0;
  while (offset < length) {
    if (peer_internal::now_ms() >= deadline) {
      error = "deadline exceeded";
      return false;
    }
    const ssize_t received = recv(fd, bytes + offset, length - offset, 0);
    if (received < 0) {
      if (errno == EINTR) {
        continue;
      }
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        if (!peer_internal::wait_fd(fd, POLLIN, deadline, error)) {
          return false;
        }
        continue;
      }
      error = std::string("recv failed: ") + std::strerror(errno);
      return false;
    }
    if (received == 0) {
      error = "unexpected end of stream";
      return false;
    }
    offset += static_cast<size_t>(received);
  }
  return true;
}

bool write_exact(int fd, const void* buffer, size_t length, int64_t deadline, std::string& error) {
  const auto* bytes = static_cast<const uint8_t*>(buffer);
  size_t offset = 0;
  while (offset < length) {
    if (peer_internal::now_ms() >= deadline) {
      error = "deadline exceeded";
      return false;
    }
    const ssize_t sent = send(fd, bytes + offset, length - offset, MSG_NOSIGNAL);
    if (sent < 0) {
      if (errno == EINTR) {
        continue;
      }
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        if (!peer_internal::wait_fd(fd, POLLOUT, deadline, error)) {
          return false;
        }
        continue;
      }
      error = std::string("send failed: ") + std::strerror(errno);
      return false;
    }
    if (sent == 0) {
      error = "socket accepted zero bytes";
      return false;
    }
    offset += static_cast<size_t>(sent);
  }
  return true;
}

}  // namespace

bool read_peer_token(int client_fd, PeerToken& token, std::string& error) {
  audit_token_t audit_token{};
  socklen_t length = sizeof(audit_token);
  if (getsockopt(client_fd, SOL_LOCAL, LOCAL_PEERTOKEN, &audit_token, &length) != 0) {
    token.error = errno;
    error = std::string("getsockopt(LOCAL_PEERTOKEN) failed: ") + std::strerror(errno);
    return false;
  }
  if (length != sizeof(audit_token)) {
    token.error = EINVAL;
    error = "LOCAL_PEERTOKEN returned an unexpected audit token size";
    return false;
  }
  token.captured = true;
  token.token = audit_token;
  token.pid = audit_token_to_pid(audit_token);
  token.euid = audit_token_to_euid(audit_token);
  token.auid = audit_token_to_auid(audit_token);
  token.ruid = audit_token_to_ruid(audit_token);
  token.rgid = audit_token_to_rgid(audit_token);
  token.asid = static_cast<uint32_t>(audit_token_to_asid(audit_token));
  token.pid_version = audit_token_to_pidversion(audit_token);
  if (token.pid <= 0) {
    error = "audit token does not identify a live peer process";
    return false;
  }
  if (token.pid_version <= 0) {
    error = "audit token pidversion must be positive";
    return false;
  }
  return true;
}

bool read_bounded_frame(int fd, size_t max_bytes, int timeout_ms, std::string& payload,
                        std::string& error) {
  const int64_t deadline = peer_internal::now_ms() + timeout_ms;
  uint8_t header[4] = {0, 0, 0, 0};
  if (!read_exact(fd, header, sizeof(header), deadline, error)) {
    return false;
  }
  const uint32_t declared = (static_cast<uint32_t>(header[0]) << 24) |
                            (static_cast<uint32_t>(header[1]) << 16) |
                            (static_cast<uint32_t>(header[2]) << 8) |
                            static_cast<uint32_t>(header[3]);
  if (declared == 0 || declared > max_bytes) {
    error = "frame length is outside the allowed bound";
    return false;
  }
  payload.assign(declared, '\0');
  return read_exact(fd, payload.data(), payload.size(), deadline, error);
}

bool write_bounded_frame(int fd, const std::string& payload, int timeout_ms, std::string& error) {
  if (payload.empty() || payload.size() > kMaxFrameBytes) {
    error = "response frame length is outside the allowed bound";
    return false;
  }
  const int64_t deadline = peer_internal::now_ms() + timeout_ms;
  const uint32_t length = static_cast<uint32_t>(payload.size());
  const uint8_t header[4] = {static_cast<uint8_t>((length >> 24) & 0xff),
                             static_cast<uint8_t>((length >> 16) & 0xff),
                             static_cast<uint8_t>((length >> 8) & 0xff),
                             static_cast<uint8_t>(length & 0xff)};
  if (!write_exact(fd, header, sizeof(header), deadline, error)) {
    return false;
  }
  return write_exact(fd, payload.data(), payload.size(), deadline, error);
}
