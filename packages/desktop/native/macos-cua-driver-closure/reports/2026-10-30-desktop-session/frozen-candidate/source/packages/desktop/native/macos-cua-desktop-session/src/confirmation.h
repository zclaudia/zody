#pragma once

#include <cstdint>
#include <functional>
#include <string>

#include "session_binding.h"

namespace zody::cua::desktop_session {

// AppKit 原生确认。必须由主线程 install/present；cancel/invalidate 可从任意线程调用，
// 内部派发回主线程。默认按钮是取消，只有明确点击“允许本次截图”才算同意。
class ConfirmationController {
 public:
  bool install();
  uint64_t present(const SessionBinding& binding,
                   std::function<void(bool allowed, const std::string& reason)> completion);
  void cancel(uint64_t generation, const std::string& reason);
  void invalidate(uint64_t generation, const std::string& reason);
  void dismissAll();

  static bool onMainThread();
  static void stopMainLoop();
};

}  // namespace zody::cua::desktop_session
