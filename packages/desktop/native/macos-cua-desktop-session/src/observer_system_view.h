#pragma once
#include "observer_source.h"
namespace zody::cua::desktop_session {
// 只表示本次元数据采样；true 仅允许截止，绝不允许读取远端内容或生成句柄。
struct ObserverSystemViewProof {
  pid_t target_pid=0, actual_before=0, actual_after=0, cg_before=0, cg_after=0;
  uint32_t target_window=0, direct_before=0, direct_after=0;
  uint64_t seconds_before=0, seconds_after=0, micros_before=0, micros_after=0;
  bool complete=false, apple_anchor=false, exact_identifier=false, exact_system_path=false;
};
bool observer_system_view_may_omit(const ObserverSystemViewProof& proof);
bool observer_system_view_opaque(AXUIElementRef node, pid_t target_pid, uint32_t target_window,
                                 pid_t actual_pid, uint32_t direct_window, ObserverReadDeadline deadline);
}
