#include "confirmation.h"

#import <AppKit/AppKit.h>
#import <dispatch/dispatch.h>

#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <utility>

#include "confirmation_state.h"

namespace zody::cua::desktop_session {
namespace {

struct ConfirmationContext {
  ConfirmationState state;
  uint64_t generation = 0;
  SessionBinding binding;
  NSAlert* __strong alert = nil;
  NSWindow* __strong window = nil;
  std::function<void(bool, const std::string&)> completion;
  bool resolved = false;
};

// 中文原因：同一时刻只允许一个活动 prompt。旧实现的 g_contexts[generation]
// 在每 present 时都从 1 开始，会覆盖前一个 context，让旧 NSAlert 的迟到
// callback 误批准新 prompt。这里只保留唯一 active context，终结后立即移除。
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

void close_prompt_on_main(ConfirmationContext& context) {
  if (context.alert == nil || context.window == nil) return;
  [NSApp endSheet:context.alert.window];
  [context.window orderOut:nil];
  [context.window close];
  context.alert = nil;
  context.window = nil;
}

void dispatch_close_and_finish(std::shared_ptr<ConfirmationContext> context, bool allowed,
                               const std::string& reason,
                               std::function<void(bool, const std::string&)> completion) {
  auto finish = ^{
    if (context) close_prompt_on_main(*context);
    if (completion) completion(allowed, reason);
  };
  if ([NSThread isMainThread]) {
    finish();
  } else {
    dispatch_async(dispatch_get_main_queue(), finish);
  }
}

void resolve_from_system(uint64_t generation, bool allowed) {
  std::shared_ptr<ConfirmationContext> context;
  std::function<void(bool, const std::string&)> completion;
  std::string reason;
  bool accepted = false;
  {
    std::lock_guard<std::mutex> lock(g_prompt_mutex);
    context = g_active_prompt;
    if (!context || context->generation != generation || context->resolved) return;
    const ConfirmationResolution resolution =
        allowed ? context->state.approve(generation)
                : context->state.deny(generation, "user-canceled");
    context->resolved = true;
    accepted = resolution.allowed && !resolution.late;
    reason = resolution.reason;
    completion = std::move(context->completion);
    // 终结后立即移除，避免 map/active 永久保留和迟到回调再次命中。
    g_active_prompt.reset();
  }
  log_confirmation_resolved(generation, accepted, reason);
  close_prompt_on_main(*context);
  // 中文原因：系统回调可能晚于取消/失效到达；必须使用状态机结果而不是原始点击值。
  if (completion) completion(accepted, reason);
}

void resolve_external(uint64_t generation, const std::string& reason, bool invalidate) {
  std::shared_ptr<ConfirmationContext> context;
  std::function<void(bool, const std::string&)> completion;
  std::string resolved_reason = reason;
  {
    std::lock_guard<std::mutex> lock(g_prompt_mutex);
    context = g_active_prompt;
    if (!context || context->generation != generation || context->resolved) return;
    // 中文原因：失效/取消必须先同步锁存；否则已排队的点击可能抢在主队列
    // 关闭窗口前获得 approve。锁存在这里完成，窗口关闭再 dispatch 到主线程。
    const ConfirmationResolution resolution =
        invalidate ? context->state.invalidate(generation, reason)
                   : context->state.deny(generation, reason);
    context->resolved = true;
    resolved_reason = resolution.reason;
    completion = std::move(context->completion);
    g_active_prompt.reset();
  }
  log_confirmation_resolved(generation, false, resolved_reason);
  dispatch_close_and_finish(context, false, resolved_reason, std::move(completion));
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

uint64_t ConfirmationController::present(
    const SessionBinding& binding,
    std::function<void(bool allowed, const std::string& reason)> completion) {
  if (![NSThread isMainThread] || !binding.valid() || !completion) return 0;

  NSWindow* window = [[NSWindow alloc]
      initWithContentRect:NSMakeRect(0, 0, 1, 1)
                styleMask:NSWindowStyleMaskBorderless
                  backing:NSBackingStoreBuffered
                    defer:NO];
  window.opaque = NO;
  window.backgroundColor = [NSColor clearColor];
  window.level = NSFloatingWindowLevel;
  // 中文原因：ConfirmationContext 在 ARC 下强持有 NSWindow；AppKit 默认
  // releasedWhenClosed=YES 会在 close 时额外 release，造成 ARC 二次释放。
  window.releasedWhenClosed = NO;

  NSAlert* alert = [[NSAlert alloc] init];
  alert.messageText = @"允许本次屏幕截图？";
  const std::string details = binding.display_text();
  alert.informativeText = [[NSString alloc] initWithBytes:details.data()
                                                  length:details.size()
                                                encoding:NSUTF8StringEncoding];
  alert.alertStyle = NSAlertStyleWarning;
  // 中文原因：取消必须是第一个（默认/Return）按钮，避免回车或关闭窗口被解释为同意。
  [alert addButtonWithTitle:@"取消"];
  [alert addButtonWithTitle:@"允许本次截图"];

  auto context = std::make_shared<ConfirmationContext>();
  context->binding = binding;
  context->alert = alert;
  context->window = window;
  context->completion = std::move(completion);

  uint64_t generation = 0;
  {
    std::lock_guard<std::mutex> lock(g_prompt_mutex);
    // 重复 present 明确拒绝，不猜应该取消哪一个；调用方必须先得到前一次的终态。
    if (g_active_prompt && !g_active_prompt->resolved) return 0;
    generation = context->state.begin(binding);
    context->generation = generation;
    g_active_prompt = context;
  }

  [window makeKeyAndOrderFront:nil];
  log_confirmation_presented(generation);
  [alert beginSheetModalForWindow:window
                completionHandler:^(NSModalResponse response) {
                  resolve_from_system(generation, response == NSAlertSecondButtonReturn);
                }];
  return generation;
}

void ConfirmationController::cancel(uint64_t generation, const std::string& reason) {
  resolve_external(generation, reason.empty() ? "user-canceled" : reason, false);
}

void ConfirmationController::invalidate(uint64_t generation, const std::string& reason) {
  resolve_external(generation, reason.empty() ? "owner-invalidated" : reason, true);
}

void ConfirmationController::dismissAll() {
  std::shared_ptr<ConfirmationContext> context;
  std::function<void(bool, const std::string&)> completion;
  {
    std::lock_guard<std::mutex> lock(g_prompt_mutex);
    context = std::move(g_active_prompt);
    g_active_prompt.reset();
    if (!context || context->resolved) return;
    context->state.invalidate(context->generation, "shutdown");
    context->resolved = true;
    completion = std::move(context->completion);
  }
  log_confirmation_resolved(context->generation, false, "shutdown");
  dispatch_close_and_finish(context, false, "shutdown", std::move(completion));
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
