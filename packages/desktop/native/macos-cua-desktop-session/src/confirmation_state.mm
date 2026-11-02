#include "confirmation_state.h"

#include <atomic>
#include <utility>

namespace zody::cua::desktop_session {
namespace {

// 中文原因：generation 必须进程单调，不能随每个 ConfirmationContext 重置为 1，
// 否则旧 prompt 的迟到回调可能命中新 context。
std::atomic<uint64_t> g_next_generation{1};

}  // namespace

uint64_t ConfirmationState::begin(const SessionBinding& binding) {
  std::lock_guard<std::mutex> lock(mutex_);
  // 新一代确认出现时，旧 prompt 即使晚到点击也不能再被接受。
  current_generation_ = g_next_generation.fetch_add(1, std::memory_order_relaxed);
  decision_ = ConfirmationDecision::Pending;
  reason_.clear();
  binding_ = binding;
  return current_generation_;
}

ConfirmationResolution ConfirmationState::approve(uint64_t generation) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (generation != current_generation_ || decision_ != ConfirmationDecision::Pending) {
    return {false, true, reason_.empty() ? "confirmation-stale" : reason_};
  }
  decision_ = ConfirmationDecision::Allowed;
  reason_ = "user-approved";
  return {true, false, reason_};
}

ConfirmationResolution ConfirmationState::deny(uint64_t generation, const std::string& reason) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (generation != current_generation_ || decision_ != ConfirmationDecision::Pending) {
    return {false, true, this->reason_.empty() ? "confirmation-stale" : this->reason_};
  }
  decision_ = ConfirmationDecision::Cancelled;
  reason_ = reason.empty() ? "user-canceled" : reason;
  return {false, false, reason_};
}

ConfirmationResolution ConfirmationState::invalidate(uint64_t generation,
                                                     const std::string& reason) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (generation != current_generation_ || decision_ != ConfirmationDecision::Pending) {
    return {false, true, this->reason_.empty() ? "confirmation-stale" : this->reason_};
  }
  decision_ = ConfirmationDecision::Invalidated;
  reason_ = reason.empty() ? "owner-invalidated" : reason;
  return {false, false, reason_};
}

ConfirmationDecision ConfirmationState::decision(uint64_t generation) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (generation != current_generation_) return ConfirmationDecision::None;
  return decision_;
}

std::string ConfirmationState::reason(uint64_t generation) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (generation != current_generation_) return "confirmation-stale";
  return reason_;
}

bool ConfirmationState::pending(uint64_t generation) const {
  return decision(generation) == ConfirmationDecision::Pending;
}

void ConfirmationState::reset() {
  std::lock_guard<std::mutex> lock(mutex_);
  current_generation_ = 0;
  decision_ = ConfirmationDecision::None;
  reason_.clear();
  binding_ = SessionBinding();
}

}  // namespace zody::cua::desktop_session
