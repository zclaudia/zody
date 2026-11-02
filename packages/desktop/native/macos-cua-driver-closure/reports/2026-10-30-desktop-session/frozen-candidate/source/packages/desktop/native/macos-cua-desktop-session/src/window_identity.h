#pragma once

#include <string>

#include "session_binding.h"

namespace zody::cua::desktop_session {

// 只按 (pid, windowId) 从 WindowServer 解析；名称/边界来自 OS，不接受调用方自报。
bool resolve_window_target(int32_t pid, uint32_t window_id, SessionTarget& target,
                           std::string& error);

// 确认后与交付前复核：同一 pid/windowId 且边界未变化。
bool window_still_matches(const SessionTarget& target, std::string& error);

}  // namespace zody::cua::desktop_session
