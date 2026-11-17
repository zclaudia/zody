#include "quit_signal_observer.h"
#include <cassert>
#include <cstdio>
#include <string>
#include <sys/wait.h>
static volatile sig_atomic_t calls = 0;
static volatile sig_atomic_t infoSender = 0;
static void Legacy(int signal) { calls++; struct sigaction action{}; action.sa_handler = SIG_DFL; sigaction(signal, &action, nullptr); }
static void WithInfo(int, siginfo_t *info, void *) { calls++; infoSender = info->si_pid; }
static quit_diagnostic::SignalFrame Read(const std::string &path) {
  int fd = open(path.c_str(), O_RDONLY | O_NOFOLLOW); assert(fd >= 0);
  quit_diagnostic::SignalFrame frame{}; assert(read(fd, &frame, sizeof(frame)) == sizeof(frame)); close(fd); return frame;
}
int main(int argc, char **argv) {
  assert(argc == 2 && argv[1][0] == '/');
  std::string base = argv[1];
  struct sigaction legacy{}; legacy.sa_handler = Legacy; legacy.sa_flags = SA_RESTART; sigaddset(&legacy.sa_mask, SIGUSR1);
  assert(sigaction(SIGTERM, &legacy, nullptr) == 0);
  assert(quit_diagnostic::Install((base + "/legacy.bin").c_str(), {SIGTERM}));
  struct sigaction installed{}; sigaction(SIGTERM, nullptr, &installed);
  assert((installed.sa_flags & SA_RESTART) && sigismember(&installed.sa_mask, SIGUSR1) == 1);
  pid_t child = fork(); assert(child >= 0);
  if (!child) { kill(getppid(), SIGTERM); _exit(0); }
  for (int i = 0; i < 1000 && !calls; i++) usleep(1000);
  assert(calls == 1); int status = 0; waitpid(child, &status, 0);
  auto frame = Read(base + "/legacy.bin"); assert(frame.signal == SIGTERM && frame.sender == child && frame.monotonicNs > 0);
  struct sigaction reset{}; sigaction(SIGTERM, nullptr, &reset); assert(reset.sa_handler == SIG_DFL);
  quit_diagnostic::Remove(); sigaction(SIGTERM, nullptr, &reset); assert(reset.sa_handler == SIG_DFL);
  struct sigaction info{}; info.sa_sigaction = WithInfo; info.sa_flags = SA_SIGINFO;
  assert(sigaction(SIGHUP, &info, nullptr) == 0); calls = 0;
  assert(quit_diagnostic::Install((base + "/info.bin").c_str(), {SIGHUP}));
  kill(getpid(), SIGHUP); assert(calls == 1 && infoSender == getpid());
  quit_diagnostic::Remove(); sigaction(SIGHUP, nullptr, &reset); assert(reset.sa_sigaction == WithInfo);
  struct sigaction ignored{}; ignored.sa_handler = SIG_IGN; sigaction(SIGINT, &ignored, nullptr);
  assert(quit_diagnostic::Install((base + "/ignored.bin").c_str(), {SIGINT, SIGTERM}));
  assert(quit_diagnostic::observed.empty()); quit_diagnostic::Remove();
  sigaction(SIGINT, nullptr, &reset); assert(reset.sa_handler == SIG_IGN);
  assert(!quit_diagnostic::Install("relative.bin", {SIGTERM}));
  puts("signal sender, legacy/info forwarding, masks and one-shot reset tests passed");
}
