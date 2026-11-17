#pragma once
#include <atomic>
#include <functional>
#include <thread>
namespace zody::cua::desktop_session {
// Owns the sole reader for the retained grant connection until revoke or clean close.
class ControlWatcher {
 public:
  ControlWatcher(std::function<bool()> live, std::function<bool()> poll,
                 std::function<void()> close, std::function<void()> invalidate);
  ~ControlWatcher();
  ControlWatcher(const ControlWatcher&) = delete;
  ControlWatcher& operator=(const ControlWatcher&) = delete;
 private:
  std::atomic<bool> stopping_{false};
  std::thread thread_;
};
}
