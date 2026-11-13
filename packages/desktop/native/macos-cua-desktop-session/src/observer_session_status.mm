#include "observer_session_status.h"
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <IOKit/IOKitLib.h>
namespace zody::cua::desktop_session {
SessionStatus evaluate_session_facts(const SessionFacts& f) {
  using B = SessionBoolean;
  if (f.console != B::True || f.login != B::True || !f.display_exists ||
      !f.display_online || !f.display_active || f.display_asleep ||
      (f.root_locked != B::True && f.root_locked != B::False) || f.cg_locked == B::Invalid)
    return SessionStatus::Unknown;
  if ((f.cg_locked == B::True && f.root_locked != B::True) ||
      (f.cg_locked == B::False && f.root_locked != B::False)) return SessionStatus::Unknown;
  return f.root_locked == B::True ? SessionStatus::Locked : SessionStatus::Allowed;
}
static SessionBoolean strict_boolean(CFTypeRef value) {
  if (!value) return SessionBoolean::Missing;
  if (CFGetTypeID(value) != CFBooleanGetTypeID()) return SessionBoolean::Invalid;
  return CFBooleanGetValue((CFBooleanRef)value) ? SessionBoolean::True : SessionBoolean::False;
}
SessionStatus observe_session_status() {
  @autoreleasepool {
    NSDictionary* session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    auto value = ^SessionBoolean(NSString* key) { return strict_boolean((__bridge CFTypeRef)session[key]); };
    io_registry_entry_t root = IORegistryGetRootEntry(kIOMainPortDefault);
    CFTypeRef locked = root ? IORegistryEntryCreateCFProperty(root, CFSTR("IOConsoleLocked"), kCFAllocatorDefault, 0) : nullptr;
    SessionBoolean root_locked = strict_boolean(locked);
    if (locked) CFRelease(locked);
    if (root) IOObjectRelease(root);
    CGDirectDisplayID display = CGMainDisplayID();
    // 中文原因：CG 私有锁屏键在本机解锁时缺失；用户锁屏校准与 XNU IOService 的内核属性共同提供独立观测，缺失或冲突仍拒绝。
    SessionFacts facts{value((__bridge NSString*)kCGSessionOnConsoleKey),
      value((__bridge NSString*)kCGSessionLoginDoneKey), root_locked,
      value(@"CGSSessionScreenIsLocked"), display != 0,
      display != 0 && CGDisplayIsOnline(display), display != 0 && CGDisplayIsActive(display),
      display == 0 || CGDisplayIsAsleep(display)};
    return evaluate_session_facts(facts);
  }
}
}
