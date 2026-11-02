#include "session_exit_policy.h"

#include <cstdio>
#include <csignal>
#include <sys/wait.h>

int main() {
  if (!zody::cua::desktop_session::exit_status_is_clean(0)) return 1;
  if (zody::cua::desktop_session::exit_status_is_clean(1 << 8)) return 2;
  if (zody::cua::desktop_session::exit_status_is_clean(SIGTERM)) return 3;
  std::printf("ok session-exit-policy\n");
  return 0;
}
