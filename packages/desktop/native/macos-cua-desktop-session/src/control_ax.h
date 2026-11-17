#pragma once
#import <ApplicationServices/ApplicationServices.h>
#include <cstdint>
namespace zody::cua::desktop_session {
enum class ControlAction { Press, SetValue };
struct ControlAX {
  AXError (*pid)(AXUIElementRef, pid_t*);
  AXError (*actual_pid)(AXUIElementRef, pid_t*);
  AXError (*window)(AXUIElementRef, uint32_t*);
  AXError (*attribute)(AXUIElementRef, CFStringRef, CFTypeRef*);
  AXError (*actions)(AXUIElementRef, CFArrayRef*);
  AXError (*settable)(AXUIElementRef, CFStringRef, Boolean*);
  AXError (*press)(AXUIElementRef, CFStringRef);
  AXError (*set)(AXUIElementRef, CFStringRef, CFTypeRef);
};
ControlAX control_ax_system();
bool control_ax_prepare(const ControlAX&, AXUIElementRef, pid_t, uint32_t, ControlAction);
AXError control_ax_send(const ControlAX&, AXUIElementRef, ControlAction, CFStringRef);
}
