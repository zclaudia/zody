#pragma once

#include <mach/message.h>
#include <sys/types.h>
#include <cstdint>
#include <string>

struct PeerToken {
  bool captured = false;
  audit_token_t token{};
  int error = 0;
  int pid = 0;
  uint32_t euid = 0;
  uint32_t auid = 0;
  uint32_t ruid = 0;
  uint32_t rgid = 0;
  uint32_t asid = 0;
  int pid_version = 0;
};

struct SocketOwnership {
  dev_t device = 0;
  ino_t inode = 0;
  uid_t uid = 0;
  bool valid = false;
};

bool validate_private_workdir(const std::string& workdir, std::string& error);
std::string peer_socket_path(const std::string& workdir);
bool bind_private_socket(const std::string& socket_path, int& fd, SocketOwnership& ownership,
                         std::string& error);
bool create_private_listener(const std::string& socket_path, int& listener_fd,
                             SocketOwnership& ownership, std::string& error);
bool accept_one_with_deadline(int listener_fd, int timeout_ms, int& client_fd, std::string& error);
bool connect_with_deadline(const std::string& socket_path, int timeout_ms, int& fd,
                           std::string& error);
bool read_peer_token(int client_fd, PeerToken& token, std::string& error);
bool read_bounded_frame(int fd, size_t max_bytes, int timeout_ms, std::string& payload, std::string& error);
bool write_bounded_frame(int fd, const std::string& payload, int timeout_ms, std::string& error);
void close_owned_socket(int fd, const std::string& socket_path, const SocketOwnership& ownership);
