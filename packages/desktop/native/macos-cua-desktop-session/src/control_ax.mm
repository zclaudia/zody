#include "control_ax.h"
#include <dlfcn.h>
namespace zody::cua::desktop_session {
ControlAX control_ax_system() {
  return {AXUIElementGetPid,
    reinterpret_cast<AXError(*)(AXUIElementRef,pid_t*)>(dlsym(RTLD_DEFAULT,"_AXUIElementGetActualPid")),
    reinterpret_cast<AXError(*)(AXUIElementRef,uint32_t*)>(dlsym(RTLD_DEFAULT,"_AXUIElementGetWindow")),
    AXUIElementCopyAttributeValue, AXUIElementCopyActionNames,
    AXUIElementIsAttributeSettable, AXUIElementPerformAction, AXUIElementSetAttributeValue};
}
namespace {
bool same_direct_identity(const ControlAX& ax, AXUIElementRef element, pid_t expected, uint32_t window) {
  if (!element || expected <= 0 || !window || !ax.pid || !ax.actual_pid || !ax.window) return false;
  pid_t pid=0, actual=0; uint32_t wid=0;
  return ax.pid(element,&pid)==kAXErrorSuccess && ax.actual_pid(element,&actual)==kAXErrorSuccess &&
      ax.window(element,&wid)==kAXErrorSuccess && pid==expected && actual==expected && wid==window;
}
}
bool control_ax_prepare(const ControlAX& ax, AXUIElementRef element, pid_t expected, uint32_t window, ControlAction action) {
  if (!same_direct_identity(ax,element,expected,window)) return false;
  if (action == ControlAction::Press) {
    if (!ax.actions) return false;
    CFArrayRef names=nullptr;
    const AXError status=ax.actions(element,&names);
    const bool supported=status==kAXErrorSuccess && names && CFGetTypeID(names)==CFArrayGetTypeID() &&
      CFArrayContainsValue(names, CFRangeMake(0,CFArrayGetCount(names)), kAXPressAction);
    if (names) CFRelease(names);
    // actions 是跨进程调用，返回时原句柄可能已经迁窗。
    return supported && same_direct_identity(ax,element,expected,window);
  }
  if (!ax.attribute || !ax.settable) return false;
  CFTypeRef role=nullptr; Boolean settable=false;
  const AXError status=ax.attribute(element,kAXRoleAttribute,&role);
  const bool text=status==kAXErrorSuccess && role && CFGetTypeID(role)==CFStringGetTypeID() &&
    CFEqual(role,kAXTextFieldRole);
  if (role) CFRelease(role);
  if (!text) return false;
  // 安全文本框和未知子角色不属于普通文本切片，不能通过 AXValue 写入。
  CFTypeRef subrole=nullptr;
  const AXError substatus=ax.attribute(element,kAXSubroleAttribute,&subrole);
  const bool ordinary=(substatus==kAXErrorNoValue || substatus==kAXErrorAttributeUnsupported) ||
    (substatus==kAXErrorSuccess && subrole && CFGetTypeID(subrole)==CFStringGetTypeID() &&
     CFEqual(subrole,CFSTR("AXStandard")));
  if (subrole) CFRelease(subrole);
  if (!ordinary || ax.settable(element,kAXValueAttribute,&settable)!=kAXErrorSuccess || !settable) return false;
  // 仅检查现有值的原生类型，不交付或记录文本；非字符串控件不属于普通文本范围。
  CFTypeRef value=nullptr;
  const AXError value_status=ax.attribute(element,kAXValueAttribute,&value);
  const bool string_value=value_status==kAXErrorSuccess && value && CFGetTypeID(value)==CFStringGetTypeID();
  if (value) CFRelease(value);
  // role/subrole/value 等 getter 可能阻塞；不能沿用读取之前的窗口归属。
  return string_value && same_direct_identity(ax,element,expected,window);
}
AXError control_ax_send(const ControlAX& ax, AXUIElementRef element, ControlAction action, CFStringRef value) {
  if (action==ControlAction::Press) return ax.press ? ax.press(element,kAXPressAction) : kAXErrorFailure;
  return ax.set && value && CFGetTypeID(value)==CFStringGetTypeID()
    ? ax.set(element,kAXValueAttribute,value) : kAXErrorFailure;
}
}
