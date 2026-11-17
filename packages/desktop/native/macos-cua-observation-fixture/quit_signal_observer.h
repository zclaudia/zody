#pragma once
#include <atomic>
#include <cerrno>
#include <cstdint>
#include <fcntl.h>
#include <signal.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <vector>

namespace quit_diagnostic {
struct SignalFrame { int32_t signal, sender, uid, code; int64_t monotonicNs; };
static_assert(sizeof(SignalFrame) == 24);
static_assert(std::atomic<int>::is_always_lock_free);
static int frameFd = -1;
static struct sigaction previous[NSIG];
static std::vector<int> observed;
static std::atomic<int> lastSender{0}, lastSignal{0};

static void Observe(int signal, siginfo_t *info, void *context) {
  const int savedErrno = errno;
  struct timespec now{}; clock_gettime(CLOCK_MONOTONIC, &now);
  const SignalFrame frame{signal, info ? info->si_pid : 0, info ? static_cast<int32_t>(info->si_uid) : -1,
    info ? info->si_code : 0, now.tv_sec * 1'000'000'000LL + now.tv_nsec};
  // 中文原因：必须先保留内核发送者，再原样调用已有退出 handler；不能吞信号使睡眠轮假通过。
  (void)write(frameFd, &frame, sizeof(frame));
  lastSender.store(frame.sender, std::memory_order_relaxed);
  lastSignal.store(signal, std::memory_order_release);
  errno = savedErrno;
  if (previous[signal].sa_flags & SA_SIGINFO) previous[signal].sa_sigaction(signal, info, context);
  else previous[signal].sa_handler(signal);
}
static void Remove() {
  for (int signal : observed) {
    struct sigaction current{};
    if (sigaction(signal, nullptr, &current) == 0 && (current.sa_flags & SA_SIGINFO) && current.sa_sigaction == Observe)
      (void)sigaction(signal, &previous[signal], nullptr);
  }
  observed.clear();
  if (frameFd >= 0) close(frameFd);
  frameFd = -1;
}
static bool Install(const char *path, const std::vector<int> &signals) {
  if (frameFd >= 0 || !path || path[0] != '/') return false;
  frameFd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_APPEND | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (frameFd < 0) return false;
  for (int signal : signals) {
    if (signal <= 0 || signal >= NSIG || sigaction(signal, nullptr, &previous[signal]) != 0) { Remove(); return false; }
    if (previous[signal].sa_handler == SIG_DFL || previous[signal].sa_handler == SIG_IGN) continue;
    struct sigaction action = previous[signal];
    action.sa_sigaction = Observe; action.sa_flags |= SA_SIGINFO;
    if (sigaction(signal, &action, nullptr) != 0) { Remove(); return false; }
    observed.push_back(signal);
  }
  return true;
}
} // namespace quit_diagnostic
