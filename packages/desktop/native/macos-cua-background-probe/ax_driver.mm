#import "ax_driver.h"
#import <ApplicationServices/ApplicationServices.h>
#include <dlfcn.h>
#include <vector>

namespace {
using GetWindow = AXError (*)(AXUIElementRef, uint32_t *);
constexpr size_t kMaxNodes = 4096;
constexpr size_t kMaxDepth = 64;
constexpr float kAXTimeoutSeconds = 2.0f;

struct Element {
  AXUIElementRef value;
  explicit Element(AXUIElementRef v = nullptr) : value(v) {}
  ~Element() {
    if (value) CFRelease(value);
  }
  Element(const Element &) = delete;
  Element &operator=(const Element &) = delete;
};

NSString *StringAttribute(AXUIElementRef element, CFStringRef key) {
  CFTypeRef value = nullptr;
  AXError status = AXUIElementCopyAttributeValue(element, key, &value);
  if (status != kAXErrorSuccess || !value) {
    if (value) CFRelease(value);
    return nil;
  }
  NSString *result =
      CFGetTypeID(value) == CFStringGetTypeID() ? [(__bridge NSString *)value copy] : nil;
  CFRelease(value);
  return result;
}

bool HasLabel(AXUIElementRef element, NSString *label) {
  return [StringAttribute(element, kAXTitleAttribute) isEqualToString:label] ||
         [StringAttribute(element, kAXDescriptionAttribute) isEqualToString:label] ||
         [StringAttribute(element, CFSTR("AXIdentifier")) isEqualToString:label];
}

// Resolve afresh for every dispatch: AX references can outlive their window.
AXUIElementRef FindWindow(pid_t pid, uint32_t windowID, GetWindow getWindow, NSString **error) {
  Element app(AXUIElementCreateApplication(pid));
  if (!app.value || AXUIElementSetMessagingTimeout(app.value, kAXTimeoutSeconds) != kAXErrorSuccess) {
    *error = @"Cannot set AX messaging timeout";
    return nullptr;
  }
  CFTypeRef raw = nullptr;
  AXError status = AXUIElementCopyAttributeValue(app.value, kAXWindowsAttribute, &raw);
  if (status != kAXErrorSuccess || !raw || CFGetTypeID(raw) != CFArrayGetTypeID()) {
    if (raw) CFRelease(raw);
    *error = [NSString stringWithFormat:@"Cannot read AX windows (%d)", status];
    return nullptr;
  }
  CFArrayRef windows = (CFArrayRef)raw;
  AXUIElementRef found = nullptr;
  NSUInteger count = 0;
  for (CFIndex i = 0; i < CFArrayGetCount(windows); i++) {
    CFTypeRef candidate = CFArrayGetValueAtIndex(windows, i);
    if (CFGetTypeID(candidate) != AXUIElementGetTypeID()) continue;
    uint32_t id = 0;
    pid_t owner = 0;
    if (getWindow((AXUIElementRef)candidate, &id) == kAXErrorSuccess && id == windowID &&
        AXUIElementGetPid((AXUIElementRef)candidate, &owner) == kAXErrorSuccess && owner == pid) {
      found = (AXUIElementRef)candidate;
      count++;
    }
  }
  if (count == 1)
    CFRetain(found);
  else {
    found = nullptr;
    *error = @"Target AX window missing or ambiguous";
  }
  CFRelease(raw);
  return found;
}

struct Matches {
  std::vector<AXUIElementRef> buttons;
  std::vector<AXUIElementRef> fields;

  ~Matches() {
    for (auto element : buttons) CFRelease(element);
    for (auto element : fields) CFRelease(element);
  }
};
bool Walk(AXUIElementRef element, size_t depth, size_t &visited, Matches &matches, NSString **error) {
  if (++visited > kMaxNodes || depth > kMaxDepth) {
    *error = @"AX traversal limit exceeded";
    return false;
  }
  if (AXUIElementSetMessagingTimeout(element, kAXTimeoutSeconds) != kAXErrorSuccess) {
    *error = @"Cannot set AX messaging timeout on descendant";
    return false;
  }
  NSString *role = StringAttribute(element, kAXRoleAttribute);
  if ([role isEqualToString:(__bridge NSString *)kAXButtonRole] && HasLabel(element, @"Probe Button")) {
    CFRetain(element);
    matches.buttons.push_back(element);
  }
  if ([role isEqualToString:(__bridge NSString *)kAXTextFieldRole] &&
      HasLabel(element, @"Probe Field")) {
    CFRetain(element);
    matches.fields.push_back(element);
  }
  CFTypeRef raw = nullptr;
  AXError status = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &raw);
  if (status == kAXErrorNoValue || status == kAXErrorAttributeUnsupported) {
    if (raw) CFRelease(raw);
    return true;
  }
  if (status != kAXErrorSuccess || !raw || CFGetTypeID(raw) != CFArrayGetTypeID()) {
    if (raw) CFRelease(raw);
    *error = [NSString stringWithFormat:@"Cannot read AX children (%d)", status];
    return false;
  }
  CFArrayRef children = (CFArrayRef)raw;
  bool ok = true;
  for (CFIndex i = 0; i < CFArrayGetCount(children) && ok; i++) {
    CFTypeRef child = CFArrayGetValueAtIndex(children, i);
    if (CFGetTypeID(child) == AXUIElementGetTypeID())
      ok = Walk((AXUIElementRef)child, depth + 1, visited, matches, error);
  }
  CFRelease(raw);
  return ok;
}

bool Resolve(pid_t pid, uint32_t windowID, GetWindow getWindow, Matches &matches, NSString **error) {
  Element window(FindWindow(pid, windowID, getWindow, error));
  if (!window.value) return false;
  size_t visited = 0;
  if (!Walk(window.value, 0, visited, matches, error)) return false;
  if (matches.buttons.size() != 1 || matches.fields.size() != 1) {
    *error = @"Probe controls missing or ambiguous";
    return false;
  }
  pid_t buttonPID = 0, fieldPID = 0;
  if (AXUIElementGetPid(matches.buttons[0], &buttonPID) != kAXErrorSuccess || buttonPID != pid ||
      AXUIElementGetPid(matches.fields[0], &fieldPID) != kAXErrorSuccess || fieldPID != pid) {
    *error = @"Control PID does not match target";
    return false;
  }
  CFArrayRef actions = nullptr;
  AXError actionStatus = AXUIElementCopyActionNames(matches.buttons[0], &actions);
  bool canPress =
      actionStatus == kAXErrorSuccess && actions && CFGetTypeID(actions) == CFArrayGetTypeID() &&
      CFArrayContainsValue(actions, CFRangeMake(0, CFArrayGetCount(actions)), kAXPressAction);
  if (actions) CFRelease(actions);
  if (!canPress) {
    *error = @"Probe button does not advertise AXPress";
    return false;
  }
  Boolean settable = false;
  AXError status = AXUIElementIsAttributeSettable(matches.fields[0], kAXValueAttribute, &settable);
  if (status != kAXErrorSuccess || !settable) {
    *error = @"Probe field AXValue is not settable";
    return false;
  }
  return true;
}
}  // namespace

NSDictionary *RunBackgroundAXProbe(pid_t pid, uint32_t windowID, BOOL (^allowDispatch)(void),
                                   BOOL (^awaitNextForegroundKey)(void)) {
  @autoreleasepool {
    NSMutableDictionary *result = [@{
      @"ok" : @NO,
      @"press_attempted" : @NO,
      @"press_possibly_sent" : @NO,
      @"set_value_attempted" : @NO,
      @"set_value_possibly_sent" : @NO
    } mutableCopy];
    NSString *error = nil;
    if (pid <= 0 || windowID == 0)
      error = @"Invalid target identity";
    else if (!allowDispatch || !awaitNextForegroundKey)
      error = @"Missing dispatch gate";
    else if (!AXIsProcessTrusted())
      error = @"Accessibility permission not granted";
    GetWindow getWindow = reinterpret_cast<GetWindow>(dlsym(RTLD_DEFAULT, "_AXUIElementGetWindow"));
    if (!error && !getWindow) error = @"_AXUIElementGetWindow unavailable";
    Matches first;
    if (!error && Resolve(pid, windowID, getWindow, first, &error)) {
      // 对象引用可能在窗口重建后失效；每次发送前重新验证身份和子树，避免误操作其他窗口。
      Matches beforePress;
      if (Resolve(pid, windowID, getWindow, beforePress, &error) &&
          CFEqual(first.buttons[0], beforePress.buttons[0]) &&
          CFEqual(first.fields[0], beforePress.fields[0])) {
        if (!allowDispatch()) {
          result[@"error"] = @"Dispatch gate closed before AXPress";
          return result;
        }
        result[@"press_attempted"] = @YES;
        result[@"press_possibly_sent"] = @YES;
        AXError status = AXUIElementPerformAction(beforePress.buttons[0], kAXPressAction);
        if (status != kAXErrorSuccess)
          error = [NSString stringWithFormat:@"AXPress failed (%d); delivery uncertain", status];
        else {
          if (!awaitNextForegroundKey()) {
            result[@"error"] = @"Foreground key gate closed after AXPress";
            return result;
          }
          Matches beforeWrite;
          if (Resolve(pid, windowID, getWindow, beforeWrite, &error) &&
              CFEqual(first.buttons[0], beforeWrite.buttons[0]) &&
              CFEqual(first.fields[0], beforeWrite.fields[0])) {
            if (!allowDispatch()) {
              result[@"error"] = @"Dispatch gate closed before AXValue write";
              return result;
            }
            result[@"set_value_attempted"] = @YES;
            result[@"set_value_possibly_sent"] = @YES;
            status = AXUIElementSetAttributeValue(beforeWrite.fields[0], kAXValueAttribute,
                                                  CFSTR("probe-value"));
            if (status != kAXErrorSuccess)
              error =
                  [NSString stringWithFormat:@"AXValue write failed (%d); delivery uncertain", status];
            else
              result[@"ok"] = @YES;
          } else if (!error)
            error = @"Target controls changed before AXValue write";
        }
      } else if (!error)
        error = @"Target controls changed before AXPress";
    }
    if (error) result[@"error"] = error;
    return result;
  }
}
