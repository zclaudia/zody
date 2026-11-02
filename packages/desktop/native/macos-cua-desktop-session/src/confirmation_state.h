#pragma once

#include <cstdint>
#include <mutex>
#include <string>

#include "session_binding.h"

namespace zody::cua::desktop_session {

enum class ConfirmationDecision {
  None,
  Pending,
  Allowed,
  Cancelled,
  Invalidated,
};

struct ConfirmationResolution {
  bool allowed = false;
  bool late = false;
  std::string reason;
};

// 纯内存确认状态机：不创建授权、不缓存 ticket；generation 失配后的同意一律拒绝。
// generation 由进程级单调计数器分配，跨 controller/context 也不会重复。
class ConfirmationState {
 public:
  uint64_t begin(const SessionBinding& binding);
  ConfirmationResolution approve(uint64_t generation);
  ConfirmationResolution deny(uint64_t generation, const std::string& reason);
  ConfirmationResolution invalidate(uint64_t generation, const std::string& reason);
  ConfirmationDecision decision(uint64_t generation) const;
  std::string reason(uint64_t generation) const;
  bool pending(uint64_t generation) const;
  void reset();

 private:
  mutable std::mutex mutex_;
  uint64_t current_generation_ = 0;
  ConfirmationDecision decision_ = ConfirmationDecision::None;
  std::string reason_;
  SessionBinding binding_;
};

}  // namespace zody::cua::desktop_session
