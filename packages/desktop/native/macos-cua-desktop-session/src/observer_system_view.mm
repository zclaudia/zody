#include "observer_system_view.h"
#import <Security/Security.h>
#include <libproc.h>
#include <dlfcn.h>
#include <limits.h>
namespace zody::cua::desktop_session {
bool observer_system_view_may_omit(const ObserverSystemViewProof& p) {
  return p.complete && p.apple_anchor && p.exact_identifier && p.exact_system_path &&
    p.target_pid>0 && p.target_window>0 && p.actual_before>0 && p.actual_before!=p.target_pid &&
    p.actual_before==p.actual_after && p.actual_before==p.cg_before && p.actual_before==p.cg_after &&
    p.direct_before>0 && p.direct_before!=p.target_window && p.direct_before==p.direct_after &&
    p.seconds_before>0 && p.seconds_before==p.seconds_after && p.micros_before<1000000 &&
    p.micros_before==p.micros_after;
}
namespace {
bool stamp(pid_t pid,uint64_t& seconds,uint64_t& micros){
  proc_bsdinfo info={};
  if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))!=sizeof(info))return false;
  seconds=info.pbi_start_tvsec;micros=info.pbi_start_tvusec;
  return seconds>0&&micros<1000000;
}
pid_t window_owner(uint32_t window){
  // 中文原因：CG ID 数组元素是指针宽度的整数槽，不能把 uint32_t 地址直接强转为数组。
  const void* slot=reinterpret_cast<const void*>(static_cast<uintptr_t>(window));
  CFArrayRef wanted=CFArrayCreate(nullptr,&slot,1,nullptr);if(!wanted)return 0;
  CFArrayRef rows=CGWindowListCreateDescriptionFromArray(wanted);CFRelease(wanted);
  pid_t owner=0;
  if(rows&&CFArrayGetCount(rows)==1){
    CFTypeRef raw=CFArrayGetValueAtIndex(rows,0);
    if(raw&&CFGetTypeID(raw)==CFDictionaryGetTypeID()){
      CFDictionaryRef row=static_cast<CFDictionaryRef>(raw);
      CFTypeRef w=CFDictionaryGetValue(row,kCGWindowNumber),p=CFDictionaryGetValue(row,kCGWindowOwnerPID);
      int64_t wid=0,pid=0;
      if(w&&p&&CFGetTypeID(w)==CFNumberGetTypeID()&&CFGetTypeID(p)==CFNumberGetTypeID()&&
         CFNumberGetValue(static_cast<CFNumberRef>(w),kCFNumberSInt64Type,&wid)&&
         CFNumberGetValue(static_cast<CFNumberRef>(p),kCFNumberSInt64Type,&pid)&&
         wid==window&&pid>0&&pid<=INT_MAX)owner=static_cast<pid_t>(pid);
    }
  }
  if(rows)CFRelease(rows);return owner;
}
void signing(pid_t pid,ObserverSystemViewProof& proof){
  int value=pid;CFNumberRef number=CFNumberCreate(nullptr,kCFNumberIntType,&value);
  const void* keys[]={kSecGuestAttributePid};const void* values[]={number};
  CFDictionaryRef attrs=CFDictionaryCreate(nullptr,keys,values,1,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
  SecCodeRef code=nullptr;SecRequirementRef requirement=nullptr;CFDictionaryRef info=nullptr;CFURLRef url=nullptr;
  const OSStatus guest=SecCodeCopyGuestWithAttributes(nullptr,attrs,kSecCSDefaultFlags,&code);
  CFRelease(attrs);CFRelease(number);
  if(guest==errSecSuccess&&SecRequirementCreateWithString(CFSTR("anchor apple"),kSecCSDefaultFlags,&requirement)==errSecSuccess){
    proof.apple_anchor=SecCodeCheckValidity(code,kSecCSStrictValidate,requirement)==errSecSuccess;
    if(proof.apple_anchor&&SecCodeCopySigningInformation(code,kSecCSSigningInformation,&info)==errSecSuccess){
      CFTypeRef identifier=CFDictionaryGetValue(info,kSecCodeInfoIdentifier);
      proof.exact_identifier=identifier&&CFGetTypeID(identifier)==CFStringGetTypeID()&&
        CFEqual(identifier,CFSTR("com.apple.appkit.xpc.ThemeWidgetControlViewService"));
    }
    if(proof.exact_identifier&&SecCodeCopyPath(code,kSecCSDefaultFlags,&url)==errSecSuccess){
      NSString* path=[(__bridge NSURL*)url URLByResolvingSymlinksInPath].path;
      proof.exact_system_path=[path isEqualToString:@"/System/Library/Frameworks/AppKit.framework/Versions/C/XPCServices/ThemeWidgetControlViewService.xpc"];
    }
  }
  if(url)CFRelease(url);if(info)CFRelease(info);if(requirement)CFRelease(requirement);if(code)CFRelease(code);
}
}
bool observer_system_view_opaque(AXUIElementRef node,pid_t target_pid,uint32_t target_window,
                                pid_t actual_pid,uint32_t direct_window,ObserverReadDeadline deadline){
  // 中文原因：系统远端视图不属于目标 PID/window。这里只验证“可省略的边界”，从不调用
  // 它的任何 AX 正文/children/actions；每次重新采样，不将签名或父链转换成读取授权。
  ObserverSystemViewProof p;p.target_pid=target_pid;p.target_window=target_window;
  p.actual_before=actual_pid;p.direct_before=direct_window;
  auto within=[&]{return std::chrono::steady_clock::now()<deadline;};
  if(!within()||actual_pid<=0||actual_pid==target_pid||!direct_window||direct_window==target_window)return false;
  using Actual=AXError(*)(AXUIElementRef,pid_t*);using Window=AXError(*)(AXUIElementRef,uint32_t*);
  auto actual=reinterpret_cast<Actual>(dlsym(RTLD_DEFAULT,"_AXUIElementGetActualPid"));
  auto window=reinterpret_cast<Window>(dlsym(RTLD_DEFAULT,"_AXUIElementGetWindow"));
  if(!actual||!window||!stamp(actual_pid,p.seconds_before,p.micros_before)||!within())return false;
  p.cg_before=window_owner(direct_window);if(p.cg_before!=actual_pid||!within())return false;
  signing(actual_pid,p);if(!within()||!p.apple_anchor||!p.exact_identifier||!p.exact_system_path)return false;
  if(actual(node,&p.actual_after)!=kAXErrorSuccess||!within()||
     window(node,&p.direct_after)!=kAXErrorSuccess||!within())return false;
  p.cg_after=window_owner(direct_window);if(!within()||!stamp(actual_pid,p.seconds_after,p.micros_after))return false;
  p.complete=within();return observer_system_view_may_omit(p);
}
}
