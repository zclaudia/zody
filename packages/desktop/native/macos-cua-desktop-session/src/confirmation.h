#pragma once

#include <cstdint>
#include <string>

#include "session_binding.h"

namespace zody::cua::desktop_session {

// App 内确认：Helper 不再创建 NSAlert/NSWindow，确认弹窗由 Zody App 呈现，App 的
// 决定经 CLI authority 会话回传后由 supervisor 调用 resolveFromApp 采信。
// ConfirmationState 仍是唯一判定状态机（generation 单调、单活动 prompt、late 防护）。
// AppKit install/runloop 保留（进程结构与 runloop 不变）；begin/resolve 均无 UI，
// 不要求主线程。cancel/invalidate 可从任意线程调用。
class ConfirmationController {
 public:
  bool install();
  // 无 UI 的 begin：登记 binding、分配 generation、置 pending 并输出
  // confirmation-presented 审计 marker。已有未决 prompt 时拒绝并返回 0，
  // binding 无效同样返回 0。任意线程可调用。
  uint64_t begin(const SessionBinding& binding);
  // App 决定（来自 CLI 对 confirm 帧的响应）：allowed → approve（reason
  // user-approved）；否则 deny("user-canceled")。返回是否真正接受（state machine
  // late/invalidate 防护后的结果）；supervisor 只在该返回值为 true 时放行截图。
  // late/重复调用必须无副作用（沿用 resolved/generation 防护），不会覆盖已锁存的结果。
  bool resolveFromApp(uint64_t generation, bool allowed);
  // CLI confirm 返回 ok:false 或 confirm 帧处理失败时使用：fail-closed 失效
  // 本次确认（reason app-confirm-failed），与 owner/EOF 失效分账。
  void resolveAppConfirmFailed(uint64_t generation);
  void cancel(uint64_t generation, const std::string& reason);
  void invalidate(uint64_t generation, const std::string& reason);
  void dismissAll();

  static bool onMainThread();
  static void stopMainLoop();
};

}  // namespace zody::cua::desktop_session
