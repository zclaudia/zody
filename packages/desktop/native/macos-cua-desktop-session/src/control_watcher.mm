#include "control_watcher.h"
namespace zody::cua::desktop_session {
ControlWatcher::ControlWatcher(std::function<bool()> live, std::function<bool()> poll,
                               std::function<void()> close, std::function<void()> invalidate)
    : thread_([this, live=std::move(live), poll=std::move(poll), close=std::move(close), invalidate=std::move(invalidate)] {
        while (!stopping_.load(std::memory_order_acquire) && live()) {
          if (poll()) { invalidate(); return; }
        }
        // 正常到期必须使用 authority close，EOF 会被对端当作授权丢失。
        close();
      }) {}
ControlWatcher::~ControlWatcher() {
  stopping_.store(true,std::memory_order_release);
  if (thread_.joinable()) thread_.join();
}
}
