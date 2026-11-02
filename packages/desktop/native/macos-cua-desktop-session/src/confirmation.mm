#include "confirmation.h"

#import <AppKit/AppKit.h>
#import <dispatch/dispatch.h>

#include <cstdio>
#include <memory>
#include <mutex>
#include <string>

#include "confirmation_state.h"

namespace zody::cua::desktop_session {
namespace {

struct ConfirmationContext {
  ConfirmationState state;
  uint64_t generation = 0;
  bool resolved = false;
};

// 中文原因：同一时刻只允许一个活动 prompt。旧实现的 g_contexts[generation]
// 在每 present 时都从 1 开始，会覆盖前一个 context，让迟到的决定误批准新
// prompt。这里只保留唯一 active context，终结后立即移除。
std::mutex g_prompt_mutex;
std::shared_ptr<ConfirmationContext> g_active_prompt;

std::string diagnostic_reason(const std::string& reason) {
  std::string safe = reason.empty() ? "unknown" : reason;
  if (safe.size() > 64) safe.resize(64);
  for (char& character : safe) {
    const unsigned char byte = static_cast<unsigned char>(character);
    if (byte < 0x20 || byte > 0x7e || character == '"' || character == '\\') {
      character = '?';
    }
  }
  return safe;
}

void log_confirmation_presented(uint64_t generation) {
  std::fprintf(stderr, "[cua-native] confirmation-presented {\"generation\":%llu}\n",
               static_cast<unsigned long long>(generation));
  std::fflush(stderr);
}

void log_confirmation_resolved(uint64_t generation, bool allowed, const std::string& reason) {
  const std::string safe_reason = diagnostic_reason(reason);
  std::fprintf(stderr,
               "[cua-native] confirmation-resolved {\"generation\":%llu,\"allowed\":%s,"
               "\"reason\":\"%s\"}\n",
               static_cast<unsigned long long>(generation), allowed ? "true" : "false",
               safe_reason.c_str());
  std::fflush(stderr);
}

// 中文原因：App 决定可能晚于取消/失效到达；必须使用状态机结果而不是原始决定值，
// 已 resolved 或 generation 失配时直接返回 false，保证 late/重复调用无副作用；
// 返回 true 表示 state machine 真正接受（只有此时 supervisor 才允许进入 lease/capture）。
bool resolve_from_app(uint64_t generation, bool allowed) {
  std::shared_ptr<ConfirmationContext> context;
  std::string reason;
  bool accepted = false;
  {
    std::lock_guard<std::mutex> lock(g_prompt_mutex);
    context = g_active_prompt;
    if (!context || context->generation != generation || context->resolved) return false;
    const ConfirmationResolution resolution =
        allowed ? context->state.approve(generation)
                : context->state.deny(generation, "user-canceled");
    context->resolved = true;
    accepted = resolution.allowed && !resolution.late;
    reason = resolution.reason;
    // 终结后立即移除，避免 active 永久保留和迟到决定再次命中。
    g_active_prompt.reset();
  }
  log_confirmation_resolved(generation, accepted, reason);
  return accepted;
}

void resolve_external(uint64_t generation, const std::string& reason, bool invalidate) {
  std::string resolved_reason = reason;
  {
    std::lock_guard<std::mutex> lock(g_prompt_mutex);
    std::shared_ptr<ConfirmationContext> context = g_active_prompt;
    if (!context || context->generation != generation || context->resolved) return;
    // 中文原因：失效/取消必须在锁内同步锁存；否则迟到的 App 决定可能抢在锁存前
    // approve。锁存在这里完成，不再有关闭窗口的主线程派发。
    const ConfirmationResolution resolution =
        invalidate ? context->state.invalidate(generation, reason)
                   : context->state.deny(generation, reason);
    context->resolved = true;
    resolved_reason = resolution.reason;
    g_active_prompt.reset();
  }
  log_confirmation_resolved(generation, false, resolved_reason);
}

}  // namespace

bool ConfirmationController::onMainThread() { return [NSThread isMainThread]; }

bool ConfirmationController::install() {
  if (![NSThread isMainThread]) return false;
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    [NSApp activateIgnoringOtherApps:YES];
  }
  return true;
}

uint64_t ConfirmationController::begin(const SessionBinding& binding) {
  if (!binding.valid()) return 0;

  auto context = std::make_shared<ConfirmationContext>();
  uint64_t generation = 0;
  {
    std::lock_guard<std::mutex> lock(g_prompt_mutex);
    // 重复 begin 明确拒绝，不猜应该取消哪一个；调用方必须先得到前一次的终态。
    if (g_active_prompt && !g_active_prompt->resolved) return 0;
    generation = context->state.begin(binding);
    context->generation = generation;
    g_active_prompt = context;
  }

  log_confirmation_presented(generation);
  return generation;
}

bool ConfirmationController::resolveFromApp(uint64_t generation, bool allowed) {
  return resolve_from_app(generation, allowed);
}

void ConfirmationController::resolveAppConfirmFailed(uint64_t generation) {
  // 中文原因：CLI 返回 ok:false 或 confirm 帧处理失败时使用；与 owner 失效/
  // authority EOF 走 invalidate 的路径分账，保持审计 reason 为固定枚举
  // app-confirm-failed，且 marker 一律 allowed:false（fail-closed，不截图）。
  resolve_external(generation, "app-confirm-failed", true);
}

void ConfirmationController::cancel(uint64_t generation, const std::string& reason) {
  resolve_external(generation, reason.empty() ? "user-canceled" : reason, false);
}

void ConfirmationController::invalidate(uint64_t generation, const std::string& reason) {
  resolve_external(generation, reason.empty() ? "owner-invalidated" : reason, true);
}

void ConfirmationController::dismissAll() {
  std::shared_ptr<ConfirmationContext> context;
  {
    std::lock_guard<std::mutex> lock(g_prompt_mutex);
    context = std::move(g_active_prompt);
    g_active_prompt.reset();
    if (!context || context->resolved) return;
    context->state.invalidate(context->generation, "shutdown");
    context->resolved = true;
  }
  log_confirmation_resolved(context->generation, false, "shutdown");
}

void ConfirmationController::stopMainLoop() {
  dispatch_async(dispatch_get_main_queue(), ^{
    [NSApp stop:nil];
    NSEvent* event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
                                        location:NSZeroPoint
                                   modifierFlags:0
                                       timestamp:0
                                    windowNumber:0
                                         context:nil
                                           subtype:0
                                             data1:0
                                             data2:0];
    [NSApp postEvent:event atStart:NO];
  });
}

}  // namespace zody::cua::desktop_session
