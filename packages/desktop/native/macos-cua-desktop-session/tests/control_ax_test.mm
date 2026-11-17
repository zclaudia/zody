#import <ApplicationServices/ApplicationServices.h>
#include "control_ax.h"
#include <cassert>
using namespace zody::cua::desktop_session;
static int writes = 0;
static AXError pid(AXUIElementRef, pid_t* out) { *out=42; return kAXErrorSuccess; }
static uint32_t current_window=7;
static pid_t current_actual=42;
static bool move_actions=false, move_value=false, move_actual=false;
static AXError actual_pid(AXUIElementRef, pid_t* out) { *out=current_actual; return kAXErrorSuccess; }
static AXError wid(AXUIElementRef, uint32_t* out) { *out=current_window; return kAXErrorSuccess; }
static bool secure = false;
static int value_kind = 0;
static AXError attr(AXUIElementRef, CFStringRef key, CFTypeRef* out) {
 if (CFEqual(key,kAXValueAttribute)) {
   if (move_value) current_window=8;
   if (value_kind==2) return kAXErrorFailure;
   *out=CFRetain(value_kind==1 ? (CFTypeRef)kCFBooleanTrue : (CFTypeRef)CFSTR("")); return kAXErrorSuccess;
 }
 if (CFEqual(key,kAXSubroleAttribute)) {
   if (!secure) return kAXErrorNoValue;
   *out=CFRetain(CFSTR("AXSecureTextField")); return kAXErrorSuccess;
 }
 *out=CFRetain(CFSTR("AXTextField")); return kAXErrorSuccess;
}
static AXError actions(AXUIElementRef, CFArrayRef* out) { if (move_actions) current_window=8; if (move_actual) current_actual=43; const void* v[]={CFSTR("AXPress")}; *out=CFArrayCreate(nullptr,v,1,&kCFTypeArrayCallBacks); return kAXErrorSuccess; }
static AXError settable(AXUIElementRef, CFStringRef, Boolean* out) { *out=true; return kAXErrorSuccess; }
static AXError press(AXUIElementRef, CFStringRef) { ++writes; return kAXErrorSuccess; }
static AXError set(AXUIElementRef, CFStringRef, CFTypeRef) { ++writes; return kAXErrorSuccess; }
int main() {
 ControlAX ax{pid,actual_pid,wid,attr,actions,settable,press,set};
 auto handle=(AXUIElementRef)0x1;
 assert(control_ax_prepare(ax,handle,42,7,ControlAction::Press));
 assert(!control_ax_prepare(ax,handle,42,8,ControlAction::Press));
 assert(control_ax_prepare(ax,handle,42,7,ControlAction::SetValue));
 secure=true;
 assert(!control_ax_prepare(ax,handle,42,7,ControlAction::SetValue));
 secure=false;
 move_actions=true; assert(!control_ax_prepare(ax,handle,42,7,ControlAction::Press));
 move_actions=false; current_window=7;
 move_actual=true; assert(!control_ax_prepare(ax,handle,42,7,ControlAction::Press));
 move_actual=false; current_actual=42;
 move_value=true; assert(!control_ax_prepare(ax,handle,42,7,ControlAction::SetValue));
 move_value=false; current_window=7;
 value_kind=1; assert(!control_ax_prepare(ax,handle,42,7,ControlAction::SetValue));
 value_kind=2; assert(!control_ax_prepare(ax,handle,42,7,ControlAction::SetValue));
 value_kind=0;
 assert(writes==0);
 assert(control_ax_send(ax,handle,ControlAction::Press,nullptr)==kAXErrorSuccess && writes==1);
 assert(control_ax_send(ax,handle,ControlAction::SetValue,CFSTR("text"))==kAXErrorSuccess && writes==2);
}
