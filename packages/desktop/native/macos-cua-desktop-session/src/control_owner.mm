#include "control_owner.h"
#include "machine_lease.h"
#import <CoreFoundation/CoreFoundation.h>
namespace zody::cua::desktop_session {
ControlOwner::ControlOwner() : machine_(std::make_shared<zody::cua::round11::MachineLease>()) {
  acquire_ = [this] {
    const auto result = machine_->acquire();
    acquire_busy_ = result.status == zody::cua::round11::MachineLeaseResult::Status::Busy;
    return result.acquired();
  };
  release_ = [this] { machine_->release(); };
}
ControlOwner::ControlOwner(std::function<bool()> acquire, std::function<void()> release)
    : acquire_(std::move(acquire)), release_(std::move(release)) {}
ControlOwner::~ControlOwner() {
  shutdown();
  if (machine_ && gate_.in_flight()) {
    // 原生调用未确认结束时不能向其他 Helper 交出锁；保留 fd 直到进程退出。
    (void)new std::shared_ptr<zody::cua::round11::MachineLease>(std::move(machine_));
  }
}
void ControlOwner::release_if_idle() {
  if (held_ && !gate_.in_flight()) {
    release_(); held_ = false; generation_ = 0; scope_.clear(); window_.clear(); native_window_.reset();
  }
}
uint64_t ControlOwner::grant(const std::string& scope, const std::string& window, Time now, bool* newly_granted, std::shared_ptr<void> native_window, bool* busy) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (newly_granted) *newly_granted = false;
  if (busy) *busy = false;
  if (shutdown_ || scope.empty() || window.empty()) return 0;
  if (held_) {
    if (gate_.valid(generation_, now)) {
      const bool same_native = (!native_window_ && !native_window) ||
        (native_window_ && native_window && CFEqual(static_cast<CFTypeRef>(native_window_.get()), static_cast<CFTypeRef>(native_window.get())));
      const bool matching = scope == scope_ && window == window_ && same_native;
      if (!matching && busy) *busy = true;
      return matching ? generation_ : 0;
    }
    release_if_idle();
    if (held_) { if (busy) *busy = true; return 0; }
  }
  acquire_busy_ = false;
  if (!acquire_()) { if (busy) *busy = acquire_busy_; return 0; }
  held_ = true;
  generation_ = gate_.grant(now);
  if (!generation_) { release_if_idle(); return 0; }
  scope_ = scope; window_ = window; native_window_ = std::move(native_window);
  if (newly_granted) *newly_granted = true;
  return generation_;
}
bool ControlOwner::begin_borrow(const std::string& scope, Time now, uint64_t& generation) {
  std::lock_guard<std::mutex> lock(mutex_);
  generation = 0;
  if (!held_ || scope != scope_ || !gate_.admit(generation_, now)) return false;
  generation = generation_;
  return true;
}
bool ControlOwner::finish_borrow(uint64_t generation, bool resources_released, Time now) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!held_ || generation != generation_) return false;
  if (!resources_released) {
    // 资源状态未知不得归还 token 或释放 flock，直到进程退出。
    gate_.stop();
    return false;
  }
  // 截图不是受支持写动作，归还 token 永不刷新控制租约活动时间。
  (void)gate_.complete(generation, false, now);
  if (!gate_.valid(generation_, now)) release_if_idle();
  return !held_;
}
uint64_t ControlOwner::reserve_attempt() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (++next_attempt_ == 0) ++next_attempt_;
  return next_attempt_;
}
bool ControlOwner::live(uint64_t generation, Time now) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!held_ || generation != generation_) return false;
  if (gate_.valid(generation, now)) return true;
  release_if_idle();
  return false;
}
bool ControlOwner::valid(const std::string& scope, const std::string& window, uint64_t generation, Time now) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!held_ || scope != scope_ || window != window_ || generation != generation_) return false;
  if (gate_.valid(generation, now)) return true;
  release_if_idle();
  return false;
}
bool ControlOwner::admit(const std::string& scope, const std::string& window, uint64_t generation, Time now, uint64_t* attempt) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (attempt) *attempt = 0;
  if (!held_ || scope != scope_ || window != window_ || generation != generation_) return false;
  if (gate_.admit(generation, now)) {
    if (attempt) {
      if (++next_attempt_ == 0) ++next_attempt_;
      *attempt = next_attempt_;
    }
    return true;
  }
  if (!gate_.valid(generation_, now)) release_if_idle();
  return false;
}
bool ControlOwner::complete(uint64_t generation, bool success, Time now) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!held_ || generation != generation_) return false;
  const bool renewed = gate_.complete(generation, success, now);
  if (!gate_.valid(generation_, now)) release_if_idle();
  return renewed;
}
void ControlOwner::invalidate(uint64_t generation) {
  std::lock_guard<std::mutex> lock(mutex_);
  // 旧 watcher 的迟到 EOF 不能撤销新一代授权。
  if (!held_ || !generation || generation != generation_) return;
  gate_.stop();
  release_if_idle();
}
void ControlOwner::shutdown() {
  std::lock_guard<std::mutex> lock(mutex_);
  shutdown_ = true;
  gate_.stop();
  release_if_idle();
}
void ControlOwner::stop_scope(const std::string& scope) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!held_ || scope != scope_) return;
  gate_.stop();
  release_if_idle();
}
void ControlOwner::stop() {
  std::lock_guard<std::mutex> lock(mutex_);
  gate_.stop();
  release_if_idle();
}
}
