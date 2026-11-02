#include "session_authority_fd.h"

#include <errno.h>
#include <fcntl.h>

#include <cstring>

namespace zody::cua::desktop_session {

bool make_authority_fd_blocking(int fd, std::string& error) {
  if (fd < 0) {
    error = "authority fd unavailable";
    return false;
  }
  const int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) {
    error = std::string("cannot read authority fd flags: ") + std::strerror(errno);
    return false;
  }
  if ((flags & O_NONBLOCK) == 0) return true;
  // 中文原因：peer_socket accept 成功后会把 accepted fd 设为 O_NONBLOCK；R11
  // AuthorityClient 的 reader_loop 用 recv(..., 0) 且把 EAGAIN 当读错误关闭。
  // 交接前仅清除 O_NONBLOCK，保留其余 file-status flags，不触及 descriptor
  // flags（如 FD_CLOEXEC），避免首次 checkpoint 在延迟响应到达前误判 closed。
  if (fcntl(fd, F_SETFL, flags & ~O_NONBLOCK) != 0) {
    error = std::string("cannot make authority fd blocking: ") + std::strerror(errno);
    return false;
  }
  return true;
}

}  // namespace zody::cua::desktop_session
