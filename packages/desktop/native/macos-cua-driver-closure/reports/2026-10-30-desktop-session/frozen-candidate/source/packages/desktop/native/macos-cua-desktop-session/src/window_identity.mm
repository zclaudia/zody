#include "window_identity.h"

#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

#include <cmath>
#include <string>

namespace zody::cua::desktop_session {
namespace {

std::string display_name(id value) {
  if (![value isKindOfClass:[NSString class]]) return "";
  NSString* text = static_cast<NSString*>(value);
  constexpr NSUInteger kMaxDisplayCharacters = 160;
  if (text.length > kMaxDisplayCharacters) {
    text = [text substringToIndex:kMaxDisplayCharacters];
  }
  NSData* data = [text dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  if (data == nil) return "";
  std::string out;
  out.reserve(data.length);
  const unsigned char* bytes = static_cast<const unsigned char*>(data.bytes);
  for (NSUInteger index = 0; index < data.length; ++index) {
    // 中文原因：OS 窗口标题可含换行/控制字符，直接拼入确认正文可淹没关键
    // 核对信息；这里保留 UTF-8 字节，只把 C0/DEL 替换为空格并做长度上限。
    out.push_back((bytes[index] < 0x20 || bytes[index] == 0x7f)
                      ? static_cast<char>(' ')
                      : static_cast<char>(bytes[index]));
  }
  return out;
}

bool lookup(int32_t pid, uint32_t window_id, SessionTarget& target, std::string& error) {
  target = SessionTarget();
  CFArrayRef windows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  if (windows == nullptr) {
    error = "window-list-unavailable";
    return false;
  }
  bool found = false;
  const CFIndex count = CFArrayGetCount(windows);
  for (CFIndex index = 0; index < count; ++index) {
    NSDictionary* info = (__bridge NSDictionary*)CFArrayGetValueAtIndex(windows, index);
    if (info == nil) continue;
    const int owner_pid =
        [info[(__bridge NSString*)kCGWindowOwnerPID] intValue];
    const uint32_t number =
        [info[(__bridge NSString*)kCGWindowNumber] unsignedIntValue];
    if (owner_pid != pid || number != window_id) continue;

    CGRect bounds = CGRectZero;
    NSDictionary* bounds_dictionary = info[(__bridge NSString*)kCGWindowBounds];
    if (bounds_dictionary != nil) {
      CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds_dictionary, &bounds);
    }
    target.window_id = number;
    target.pid = owner_pid;
    target.layer = [info[(__bridge NSString*)kCGWindowLayer] intValue];
    target.x = bounds.origin.x;
    target.y = bounds.origin.y;
    target.width = bounds.size.width;
    target.height = bounds.size.height;
    target.owner_name = display_name(info[(__bridge NSString*)kCGWindowOwnerName]);
    target.window_name = display_name(info[(__bridge NSString*)kCGWindowName]);
    found = true;
    break;
  }
  CFRelease(windows);
  if (!found) {
    error = "window-target-not-found";
    return false;
  }
  if (!target.measured()) {
    error = "window-target-bounds-invalid";
    return false;
  }
  return true;
}

}  // namespace

bool resolve_window_target(int32_t pid, uint32_t window_id, SessionTarget& target,
                           std::string& error) {
  if (pid <= 0 || window_id == 0) {
    error = "window-target-invalid";
    return false;
  }
  return lookup(pid, window_id, target, error);
}

bool window_still_matches(const SessionTarget& target, std::string& error) {
  SessionTarget current;
  if (!lookup(target.pid, target.window_id, current, error)) return false;
  if (!current.same_identity(target)) {
    error = "window-target-identity-changed";
    return false;
  }
  if (!current.same_bounds(target)) {
    error = "window-target-bounds-changed";
    return false;
  }
  if (!target.window_name.empty() && current.window_name != target.window_name) {
    error = "window-target-name-changed";
    return false;
  }
  if (!target.owner_name.empty() && current.owner_name != target.owner_name) {
    error = "window-target-owner-changed";
    return false;
  }
  return true;
}

}  // namespace zody::cua::desktop_session
