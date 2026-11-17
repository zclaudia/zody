#pragma once
#include <chrono>
#include <cstdint>
#include <mutex>
namespace zody::cua::desktop_session {
// One ordering point for revocation and final admission. Never holds its lock over AX.
class ControlGate {
 public:
  using Time = std::chrono::steady_clock::time_point;
  uint64_t grant(Time now);
  bool valid(uint64_t generation, Time now);
  bool admit(uint64_t generation, Time now);
  bool complete(uint64_t generation, bool success, Time now);
  void stop();
  size_t in_flight() const;
 private:
  mutable std::mutex mutex_;
  uint64_t generation_ = 0;
  size_t pending_ = 0;
  bool active_ = false;
  Time activity_{};
};
}
