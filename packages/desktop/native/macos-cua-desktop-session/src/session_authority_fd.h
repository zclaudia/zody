#pragma once

#include <string>

namespace zody::cua::desktop_session {

// accepted authority socket 由 peer_socket 设为非阻塞；R11 AuthorityClient 的
// reader_loop 使用阻塞 recv，因此交接给 R11 前必须只清除 O_NONBLOCK 并保留其余 flags。
bool make_authority_fd_blocking(int fd, std::string& error);

}  // namespace zody::cua::desktop_session
