#pragma once

#include <cstdint>
#include <string>

namespace peer_internal {

int64_t now_ms();
bool set_nonblocking(int fd, std::string& error);
bool wait_fd(int fd, short events, int64_t deadline, std::string& error);
bool wait_writable_or_error(int fd, int64_t deadline, std::string& error);

}  // namespace peer_internal
