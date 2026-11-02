#pragma once

#include <sys/wait.h>

namespace zody::cua::desktop_session {

// 中文原因：控制流 EOF 只说明 fd3 关闭，不说明进程成功或失败；只有已回收的
// child 且 wait status 为正常 exit 0 才是干净退出，非零/信号保持 fatal。
inline bool exit_status_is_clean(int wait_status) {
  return WIFEXITED(wait_status) && WEXITSTATUS(wait_status) == 0;
}

}  // namespace zody::cua::desktop_session
