#pragma once
#include "control_gate.h"
#include <functional>
#include <memory>
#include <mutex>
#include <string>
namespace zody::cua::round11 { class MachineLease; }
namespace zody::cua::desktop_session {
// Supervisor owns this object across individual authenticated authority connections.
class ControlOwner {
 public:
  using Time = ControlGate::Time;
  ControlOwner();
  ControlOwner(std::function<bool()> acquire, std::function<void()> release);
  ~ControlOwner();
  uint64_t grant(const std::string& scope, const std::string& window, Time now, bool* newly_granted = nullptr, std::shared_ptr<void> native_window = {}, bool* busy = nullptr);
  bool begin_borrow(const std::string& scope, Time now, uint64_t& generation);
  bool finish_borrow(uint64_t generation, bool resources_released, Time now);
  zody::cua::round11::MachineLease* machine() const { return machine_.get(); }
  uint64_t reserve_attempt();
  bool live(uint64_t generation, Time now);
  bool valid(const std::string& scope, const std::string& window, uint64_t generation, Time now);
  bool admit(const std::string& scope, const std::string& window, uint64_t generation, Time now, uint64_t* attempt = nullptr);
  bool complete(uint64_t generation, bool success, Time now);
  void stop();
  void stop_scope(const std::string& scope);
  void shutdown();
  void invalidate(uint64_t generation);
 private:
  void release_if_idle();
  std::mutex mutex_;
  ControlGate gate_;
  std::shared_ptr<zody::cua::round11::MachineLease> machine_;
  std::function<bool()> acquire_;
  std::function<void()> release_;
  std::string scope_, window_;
  std::shared_ptr<void> native_window_;
  uint64_t generation_ = 0;
  uint64_t next_attempt_ = 0;
  bool held_ = false;
  bool shutdown_ = false;
  bool acquire_busy_ = false;
};
}
