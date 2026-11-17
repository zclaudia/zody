#include "control_gate.h"
namespace zody::cua::desktop_session {
uint64_t ControlGate::grant(Time now) {
  std::lock_guard<std::mutex> lock(mutex_);
  // 未完成的原生调用仍可能影响目标，不能向新 generation 转让准入。
  if (active_ && now >= activity_ && now - activity_ >= std::chrono::seconds(120)) active_ = false;
  if (pending_ || active_) return 0;
  if (++generation_ == 0) ++generation_;
  active_ = true;
  activity_ = now;
  return generation_;
}
bool ControlGate::valid(uint64_t generation, Time now) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (active_ && now >= activity_ && now - activity_ >= std::chrono::seconds(120)) active_ = false;
  return active_ && generation && generation == generation_ && now >= activity_;
}
bool ControlGate::admit(uint64_t generation, Time now) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_ || !generation || generation != generation_ || now < activity_ ||
      now - activity_ >= std::chrono::seconds(120) || pending_) {
    if (active_ && now >= activity_ && now - activity_ >= std::chrono::seconds(120)) active_ = false;
    return false;
  }
  ++pending_;
  return true;
}
bool ControlGate::complete(uint64_t generation, bool success, Time now) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!pending_) return false;
  --pending_;
  if (!active_ || generation != generation_ || !success || now < activity_ ||
      now - activity_ >= std::chrono::seconds(120)) return false;
  activity_ = now;
  return true;
}
void ControlGate::stop() {
  std::lock_guard<std::mutex> lock(mutex_);
  active_ = false;
}
size_t ControlGate::in_flight() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return pending_;
}
}
