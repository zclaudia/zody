#include "observer_source.h"
#include "observer_session_status.h"
#include "observer_system_view.h"
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <dlfcn.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>

namespace zody::cua::desktop_session {
// 中文原因：系统错误和应用内容均不可进入诊断，所有字段经过固定白名单归一。
std::string observer_conflict_format(bool at_root, const std::string& role, const std::string& direct, const std::string& ax_window, bool same_reference) {
  static const char* roles[] = {"window", "button", "text", "group", "other", "unknown"};
  static const char* directs[] = {"target", "same_process", "other_process", "missing", "unknown"};
  static const char* windows[] = {"target", "direct", "other", "missing", "invalid", "unknown"};
  const char *r="unknown", *d="unknown", *w="unknown";
  for (const char* item : roles) if (role == item) r=item;
  for (const char* item : directs) if (direct == item) d=item;
  for (const char* item : windows) if (ax_window == item) w=item;
  return std::string("[cua-native] observation-window-conflict {\"atRoot\":") + (at_root ? "true" : "false") +
    ",\"role\":\"" + r + "\",\"direct\":\"" + d + "\",\"axWindow\":\"" + w +
    "\",\"axWindowIsTargetReference\":" + (same_reference ? "true" : "false") + "}";
}
void observer_conflict_diagnostic(bool at_root, const std::string& role, const std::string& direct, const std::string& ax_window, bool same_reference) {
  std::string line=observer_conflict_format(at_root, role, direct, ax_window, same_reference);
  std::fprintf(stderr, "%s\n", line.c_str());
}
const char* observer_direct_window_mismatch_phase(uint32_t window_id) {
  return window_id == 0 ? "node_direct_window_zero" : "node_direct_window";
}
std::string observer_diagnostic_format(const std::string& phase, const std::string& error, AXError status) {
  static const char* phases[] = {"ax_app_create", "ax_windows_status", "ax_windows_missing", "ax_windows_type", "ax_unique", "eligible", "node_pid", "node_direct_window", "node_direct_window_zero", "node_ax_window", "node_role", "launch_date", "cg_windows", "cg_unique", "bounds", "resolve_before", "read", "resolve_after", "final_resolve", "read_resolve_before", "read_resolve_after", "metadata_cg_windows"};
  static const char* errors[] = {"element_unavailable", "invalid_request", "broker_unavailable", "permission_denied", "not_authorized", "screen_locked", "stale_state", "structured_state_unavailable", "timeout"};
  const char* p = "unknown"; const char* e = "unknown";
  for (const char* item : phases) if (phase == item) p = item;
  for (const char* item : errors) if (error == item) e = item;
  const char* a = "unknown";
  switch (status) {
    case kAXErrorSuccess: a = "success"; break;
    case kAXErrorFailure: a = "failure"; break;
    case kAXErrorIllegalArgument: a = "illegal_argument"; break;
    case kAXErrorInvalidUIElement: a = "invalid_element"; break;
    case kAXErrorCannotComplete: a = "cannot_complete"; break;
    case kAXErrorAttributeUnsupported: a = "attribute_unsupported"; break;
    case kAXErrorNoValue: a = "no_value"; break;
    case kAXErrorNotImplemented: a = "not_implemented"; break;
    default: break;
  }
  return std::string("[cua-native] observation-rejected {\"phase\":\"") + p + "\",\"code\":\"" + e + "\",\"ax\":\"" + a + "\"}";
}
void observer_diagnostic(const std::string& phase, const std::string& error, AXError status) {
  std::string line = observer_diagnostic_format(phase, error, status);
  std::fprintf(stderr, "%s\n", line.c_str());
}
// 中文原因：必须在 UTF-8 完整码点截断，避免半个字符进入 wire 或模型基线。
NSString* observer_clip_text(NSString* input, bool& truncated) {
  if (![input isKindOfClass:[NSString class]]) return @"";
  NSData* bytes = [input dataUsingEncoding:NSUTF8StringEncoding];
  if (bytes.length <= 256) return input;
  NSUInteger n = 256;
  NSString* out = nil;
  while (n && !(out = [[NSString alloc] initWithData:[bytes subdataWithRange:NSMakeRange(0, n)] encoding:NSUTF8StringEncoding])) --n;
  truncated = true;
  return out ?: @"";
}
bool observer_traversal_admit(size_t count, size_t depth, bool& truncated) {
  if (count >= 64 || depth >= 16) { truncated=true; return false; }
  return true;
}
ObserverAttributeDisposition observer_attribute_disposition(AXError status, bool required) {
  if (status == kAXErrorSuccess) return ObserverAttributeDisposition::Present;
  if (!required && (status == kAXErrorNoValue || status == kAXErrorAttributeUnsupported)) return ObserverAttributeDisposition::Absent;
  return ObserverAttributeDisposition::Failure;
}
bool observer_same_process(NSDate* expected, NSDate* actual) {
  return expected && actual && [expected isEqualToDate:actual];
}
bool observer_unique_count(size_t count) { return count == 1; }
bool observer_window_matches(pid_t expected_pid, pid_t actual_pid, bool has_window_id, uint32_t expected_id, uint32_t actual_id) {
  return expected_pid > 0 && expected_pid == actual_pid && expected_id != 0 && (!has_window_id || expected_id == actual_id);
}
namespace {
using GetWindow = AXError (*)(AXUIElementRef, uint32_t*);
constexpr size_t kMaxElements = 64;
NSDictionary* app_info(NSRunningApplication* app) {
  return @{ @"pid": @(app.processIdentifier), @"name": app.localizedName ?: @"", @"bundle_id": app.bundleIdentifier ?: [NSNull null], @"active": @(app.active) };
}
bool match_app(NSRunningApplication* app, id ref) {
  if (!ref) return true;
  if ([ref isKindOfClass:[NSString class]]) return [app.bundleIdentifier isEqualToString:ref];
  if (![ref isKindOfClass:[NSDictionary class]]) return false;
  if (ref[@"pid"] && [ref[@"pid"] intValue] != app.processIdentifier) return false;
  if (ref[@"name"] && ![app.localizedName isEqualToString:ref[@"name"]]) return false;
  if (ref[@"bundle_id"] && ![app.bundleIdentifier isEqualToString:ref[@"bundle_id"]]) return false;
  return true;
}
NSRunningApplication* unique_app(id ref, std::string& error) {
  NSRunningApplication* found = nil;
  for (NSRunningApplication* app in NSWorkspace.sharedWorkspace.runningApplications) {
    if (!app.terminated && match_app(app, ref)) { if (found) { error = "invalid_request"; return nil; } found = app; }
  }
  if (!found) error = "invalid_request";
  return found;
}
NSArray* cg_windows(CGWindowListOption option) {
  return CFBridgingRelease(CGWindowListCopyWindowInfo(option | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
}
NSDictionary* info_for(pid_t pid, uint32_t wid, NSArray* windows) {
  for (NSDictionary* info in windows) if ([info[(__bridge NSString*)kCGWindowOwnerPID] intValue] == pid && [info[(__bridge NSString*)kCGWindowNumber] unsignedIntValue] == wid) return info;
  return nil;
}
bool bool_attr(AXUIElementRef e, CFStringRef key, bool& value) {
  CFTypeRef raw = nullptr; AXError status = AXUIElementCopyAttributeValue(e,key,&raw);
  if (status != kAXErrorSuccess || !raw || CFGetTypeID(raw) != CFBooleanGetTypeID()) { if (raw) CFRelease(raw); return false; }
  value = CFBooleanGetValue((CFBooleanRef)raw); CFRelease(raw); return true;
}
using Deadline = std::chrono::steady_clock::time_point;
// 中文原因：每次 IPC 使用总预算的剩余时间，避免单次 2 秒超时叠加越过观察期限。
bool prepare_read(AXUIElementRef node, const Deadline& deadline, std::string& error, const ObserverAXReader* reader=nullptr) {
  auto remaining=std::chrono::duration<double>(deadline-std::chrono::steady_clock::now()).count();
  if (remaining<=0) { error="timeout"; return false; }
  if ((reader ? reader->timeout : AXUIElementSetMessagingTimeout)(node,static_cast<float>(std::min(2.0,remaining)))!=kAXErrorSuccess) { error="structured_state_unavailable"; return false; }
  return true;
}
id attr(AXUIElementRef e, CFStringRef key, bool required, bool& truncated, std::string& error, const Deadline* deadline=nullptr, const ObserverAXReader* reader=nullptr) {
  if (deadline && !prepare_read(e,*deadline,error,reader)) return nil;
  CFTypeRef raw = nullptr; AXError status = (reader ? reader->attribute : AXUIElementCopyAttributeValue)(e,key,&raw);
  const auto disposition=observer_attribute_disposition(status,required);
  if (disposition==ObserverAttributeDisposition::Absent) { if (raw) CFRelease(raw); return [NSNull null]; }
  if (disposition==ObserverAttributeDisposition::Failure || !raw) {
    if (raw) CFRelease(raw); error = "structured_state_unavailable"; return nil;
  }
  NSString* text=nil;
  if (CFGetTypeID(raw)==CFStringGetTypeID()) text=(__bridge NSString*)raw;
  else if (key==kAXValueAttribute && (CFGetTypeID(raw)==CFNumberGetTypeID() || CFGetTypeID(raw)==CFBooleanGetTypeID())) text=[(__bridge id)raw description];
  if (!text) { CFRelease(raw); error="structured_state_unavailable"; return nil; }
  NSString* value = observer_clip_text(text, truncated); CFRelease(raw);
  if (required && value.length == 0) { error = "structured_state_unavailable"; return nil; }
  return value;
}
AXUIElementRef find_ax(pid_t pid, uint32_t wid, std::string& error) {
  auto get = reinterpret_cast<GetWindow>(dlsym(RTLD_DEFAULT, "_AXUIElementGetWindow"));
  if (!get) { error = "broker_unavailable"; return nullptr; }
  if (!AXIsProcessTrusted()) { error = "permission_denied"; return nullptr; }
  AXUIElementRef app = AXUIElementCreateApplication(pid); if (!app) { error = "element_unavailable"; observer_diagnostic("ax_app_create", error); return nullptr; }
  if (AXUIElementSetMessagingTimeout(app, 2.0f) != kAXErrorSuccess) { CFRelease(app); error = "structured_state_unavailable"; return nullptr; }
  CFTypeRef raw = nullptr; AXError status = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &raw); CFRelease(app);
  if (status != kAXErrorSuccess || !raw || CFGetTypeID(raw) != CFArrayGetTypeID()) { if (raw) CFRelease(raw); error = "element_unavailable"; observer_diagnostic(status != kAXErrorSuccess ? "ax_windows_status" : !raw ? "ax_windows_missing" : "ax_windows_type", error, status); return nullptr; }
  AXUIElementRef found = nullptr; unsigned count = 0;
  CFArrayRef arr = (CFArrayRef)raw;
  for (CFIndex i=0;i<CFArrayGetCount(arr);++i) {
    CFTypeRef v = CFArrayGetValueAtIndex(arr,i); uint32_t id=0; pid_t owner=0;
    if (CFGetTypeID(v)==AXUIElementGetTypeID() && get((AXUIElementRef)v,&id)==kAXErrorSuccess && id==wid && AXUIElementGetPid((AXUIElementRef)v,&owner)==kAXErrorSuccess && owner==pid) { found=(AXUIElementRef)v; ++count; }
  }
  if (count==1) CFRetain(found); else { found=nullptr; error="element_unavailable"; observer_diagnostic("ax_unique", error); }
  CFRelease(raw); return found;
}
bool session_ok(std::string& error) {
  SessionStatus status = observe_session_status();
  if (status != SessionStatus::Allowed) {
    error = status == SessionStatus::Locked ? "screen_locked" : "not_authorized";
    return false;
  }
  return true;
}
bool eligible_target(NSRunningApplication* app, uint32_t wid, AXUIElementRef window, std::string& error) {
  if (!session_ok(error)) return false;
  NSArray* onscreen = cg_windows(kCGWindowListOptionOnScreenOnly);
  bool minimized = true; bool known = bool_attr(window,kAXMinimizedAttribute,minimized);
  if (!observer_eligible(true,true,true,false,app != nil,app.hidden,onscreen && info_for(app.processIdentifier,wid,onscreen),known,minimized)) { error="element_unavailable"; observer_diagnostic("eligible", error); return false; }
  return true;
}
bool walk(AXUIElementRef node, AXUIElementRef root, pid_t pid, uint32_t wid, size_t depth,
          std::chrono::steady_clock::time_point deadline, NSMutableArray* elements,
          NSMutableArray* handles, bool& truncated, std::string& error, const ObserverAXReader& reader) {
  if (std::chrono::steady_clock::now() >= deadline) { error="timeout"; return false; }
  if (!observer_traversal_admit(elements.count,depth,truncated)) return true;
  if (!prepare_read(node,deadline,error,&reader)) return false;
  pid_t owner=0;
  AXError pid_status=reader.pid(node,&owner);
  if (pid_status!=kAXErrorSuccess || !observer_window_matches(pid,owner,false,wid,0)) { error="element_unavailable"; observer_diagnostic("node_pid", error, pid_status); return false; }
  auto get_window=reader.window;
  if (!get_window) { error="broker_unavailable"; return false; }
  uint32_t direct_id=0;pid_t actual_pid=0;
  if (!prepare_read(node,deadline,error,&reader)) return false;
  const AXError direct_status=get_window(node,&direct_id);
  if (!reader.actual_pid || reader.actual_pid(node,&actual_pid)!=kAXErrorSuccess || actual_pid<=0) {
    error="element_unavailable";observer_diagnostic("node_pid",error);return false;
  }
  if (direct_status!=kAXErrorSuccess) { error="element_unavailable";observer_diagnostic("node_direct_window",error,direct_status);return false; }
  if (actual_pid!=pid) {
    // 中文原因：跨进程节点只能成为不透明截止边界，永不进入正文/children/actions 或索引。
    // root、未知服务、身份变化与预算耗尽仍拒绝，签名不是窗口归属授权。
    if (depth>0 && reader.opaque && reader.opaque(node,pid,wid,actual_pid,direct_id,deadline) &&
        std::chrono::steady_clock::now()<deadline) {
      truncated=true;
      std::fprintf(stderr,"[cua-native] observation-system-view-omitted {\"reason\":\"appkit_theme_widget_remote_view\"}\n");
      return true;
    }
    error="element_unavailable";observer_diagnostic("node_pid",error);return false;
  }
  if (!observer_window_matches(pid,owner,true,wid,direct_id)) { error="element_unavailable"; observer_diagnostic(observer_direct_window_mismatch_phase(direct_id), error); return false; }
  if (!prepare_read(node,deadline,error,&reader)) return false;
  CFTypeRef raw_window=nullptr; AXError window_status=reader.attribute(node,kAXWindowAttribute,&raw_window);
  if (window_status==kAXErrorSuccess && raw_window) {
    auto get=reader.window; uint32_t actual=0;
    if (CFGetTypeID(raw_window)==AXUIElementGetTypeID() && !prepare_read((AXUIElementRef)raw_window,deadline,error,&reader)) { CFRelease(raw_window); return false; }
    bool matches=CFGetTypeID(raw_window)==AXUIElementGetTypeID() && get && get((AXUIElementRef)raw_window,&actual)==kAXErrorSuccess && actual==wid;
    CFRelease(raw_window); if (!matches) { error="element_unavailable"; observer_diagnostic("node_ax_window", error, window_status); return false; }
  } else {
    if (raw_window) CFRelease(raw_window);
    if (window_status!=kAXErrorNoValue && window_status!=kAXErrorAttributeUnsupported) { error="structured_state_unavailable"; return false; }
  }
  id role=attr(node,kAXRoleAttribute,true,truncated,error,&deadline,&reader); if (!role) return false;
  if ([role isEqualToString:(__bridge NSString*)kAXApplicationRole] ||
      [role isEqualToString:(__bridge NSString*)kAXMenuBarRole]) { error="element_unavailable"; observer_diagnostic("node_role", error); return false; }
  id title=attr(node,kAXTitleAttribute,false,truncated,error,&deadline,&reader); if (!title) return false;
  id value=attr(node,kAXValueAttribute,false,truncated,error,&deadline,&reader); if (!value) return false;
  NSMutableArray* actions = [NSMutableArray array]; CFArrayRef raw_actions = nullptr;
  if (!prepare_read(node,deadline,error,&reader)) return false;
  AXError actions_status=reader.actions(node,&raw_actions);
  if (actions_status==kAXErrorSuccess && raw_actions && CFGetTypeID(raw_actions)==CFArrayGetTypeID()) {
    for (id action in (__bridge NSArray*)raw_actions) {
      if (actions.count >= kMaxElements) { truncated=true; break; }
      if ([action isKindOfClass:[NSString class]]) [actions addObject:observer_clip_text(action,truncated)];
    }
    CFRelease(raw_actions);
  } else if (actions_status!=kAXErrorNoValue && actions_status!=kAXErrorAttributeUnsupported) {
    if (raw_actions) CFRelease(raw_actions); error="structured_state_unavailable"; return false;
  }
  [elements addObject:@{ @"index": @(elements.count), @"kind": role, @"title": title, @"value": value, @"actions": actions }];
  [handles addObject:(__bridge id)node];
  if (!prepare_read(node,deadline,error,&reader)) return false;
  CFTypeRef children = nullptr; AXError status = reader.attribute(node,kAXChildrenAttribute,&children);
  if (status==kAXErrorNoValue || status==kAXErrorAttributeUnsupported) { if(children) CFRelease(children); return true; }
  if (status!=kAXErrorSuccess || !children || CFGetTypeID(children)!=CFArrayGetTypeID()) { if(children) CFRelease(children); error="structured_state_unavailable"; return false; }
  bool ok=true; CFArrayRef list=(CFArrayRef)children;
  for (CFIndex i=0;i<CFArrayGetCount(list)&&ok;++i) {
    if (elements.count >= kMaxElements) { truncated=true; break; }
    CFTypeRef child=CFArrayGetValueAtIndex(list,i); if (CFGetTypeID(child)==AXUIElementGetTypeID()) ok=walk((AXUIElementRef)child,root,pid,wid,depth+1,deadline,elements,handles,truncated,error,reader);
  }
  CFRelease(children); return ok;
}
}
bool observer_walk_tree(AXUIElementRef root, pid_t pid, uint32_t wid, ObserverReadDeadline deadline,
                        NSMutableArray* elements, NSMutableArray* handles, bool& truncated,
                        std::string& error, const ObserverAXReader& reader) {
  const bool ok=walk(root,root,pid,wid,0,deadline,elements,handles,truncated,error,reader);
  if (!ok) { [elements removeAllObjects]; [handles removeAllObjects]; }
  return ok;
}
bool observer_eligible(bool console, bool login, bool lock_known, bool locked, bool hidden_known, bool hidden, bool onscreen, bool min_known, bool minimized) { return console && login && lock_known && !locked && hidden_known && !hidden && onscreen && min_known && !minimized; }
NSArray* observer_list_apps(std::string& error) {
  NSMutableArray* out=[NSMutableArray array];
  for (NSRunningApplication* app in NSWorkspace.sharedWorkspace.runningApplications) if (!app.terminated && app.processIdentifier>0) [out addObject:app_info(app)];
  error.clear(); return out;
}
NSArray* observer_list_windows(id ref, std::string& error) {
  NSRunningApplication* selected = ref ? unique_app(ref,error) : nil; if (ref && !selected) return nil;
  NSArray* windows=cg_windows(kCGWindowListOptionAll); if (!windows) { error="element_unavailable"; observer_diagnostic("metadata_cg_windows", error); return nil; }
  NSMutableArray* out=[NSMutableArray array];
  NSArray* onscreen=cg_windows(kCGWindowListOptionOnScreenOnly);
  if (!onscreen) { error="broker_unavailable"; return nil; }
  for (NSDictionary* info in windows) {
    pid_t pid=[info[(__bridge NSString*)kCGWindowOwnerPID] intValue]; uint32_t wid=[info[(__bridge NSString*)kCGWindowNumber] unsignedIntValue];
    if (pid<=0 || wid==0 || (selected && selected.processIdentifier!=pid) ||
        ([ref isKindOfClass:[NSDictionary class]] && ref[@"window_id"] && [ref[@"window_id"] unsignedIntValue]!=wid)) continue;
    id title=info[(__bridge NSString*)kCGWindowName]; if (![title isKindOfClass:[NSString class]] || [title length]==0) title=[NSNull null];
    CGRect rect=CGRectZero;
    if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)info[(__bridge NSString*)kCGWindowBounds],&rect)) { error="structured_state_unavailable"; return nil; }
    NSMutableDictionary* row=[@{ @"pid": @(pid), @"window_id": @(wid), @"title": title,
      @"text_preview": [NSNull null], @"bounds": @{ @"x": @(rect.origin.x), @"y": @(rect.origin.y), @"width": @(rect.size.width), @"height": @(rect.size.height) },
      @"main": [NSNull null], @"focused": [NSNull null], @"onscreen": @(info_for(pid,wid,onscreen)!=nil) } mutableCopy];
    std::string ax_error; AXUIElementRef ax=find_ax(pid,wid,ax_error);
    if (ax) {
      bool truncate=false; std::string attr_error;
      id ax_title=attr(ax,kAXTitleAttribute,false,truncate,attr_error);
      if (ax_title && ax_title != [NSNull null]) row[@"title"]=ax_title;
      id subrole=attr(ax,kAXSubroleAttribute,false,truncate,attr_error);
      if (subrole && subrole != [NSNull null]) row[@"subrole"]=subrole;
      bool flag=false; if (bool_attr(ax,kAXMainAttribute,flag)) row[@"main"]=@(flag);
      if (bool_attr(ax,kAXFocusedAttribute,flag)) row[@"focused"]=@(flag);
      CFRelease(ax);
    }
    [out addObject:row];
  }
  error.clear(); return out;
}
bool observer_resolve_window(id ref, ObserverWindow& result, std::string& error) {
  result=ObserverWindow(); NSRunningApplication* app=unique_app(ref,error); if (!app) return false;
  if (!app.launchDate) { error="element_unavailable"; observer_diagnostic("launch_date", error); return false; }
  NSArray* windows=cg_windows(kCGWindowListOptionOnScreenOnly); if (!windows) { error="element_unavailable"; observer_diagnostic("cg_windows", error); return false; }
  uint32_t requested=[ref isKindOfClass:[NSDictionary class]] ? [ref[@"window_id"] unsignedIntValue] : 0;
  NSDictionary* info=nil; AXUIElementRef ax=nullptr; unsigned eligible_count=0;
  std::string last_error="element_unavailable";
  for (NSDictionary* candidate in windows) {
    uint32_t candidate_id=[candidate[(__bridge NSString*)kCGWindowNumber] unsignedIntValue];
    if ([candidate[(__bridge NSString*)kCGWindowOwnerPID] intValue]!=app.processIdentifier || !candidate_id ||
        (requested && requested!=candidate_id) || [candidate[(__bridge NSString*)kCGWindowLayer] intValue]!=0) continue;
    std::string candidate_error; AXUIElementRef candidate_ax=find_ax(app.processIdentifier,candidate_id,candidate_error);
    if (!candidate_ax) { last_error=candidate_error; continue; }
    if (!eligible_target(app,candidate_id,candidate_ax,candidate_error)) { CFRelease(candidate_ax); last_error=candidate_error; continue; }
    ++eligible_count;
    if (!ax) { ax=candidate_ax; info=candidate; } else CFRelease(candidate_ax);
  }
  if (!observer_unique_count(eligible_count)) { if (ax) CFRelease(ax); error=eligible_count ? "invalid_request" : last_error; observer_diagnostic("cg_unique", error); return false; }
  uint32_t wid=[info[(__bridge NSString*)kCGWindowNumber] unsignedIntValue];
  CGRect rect=CGRectZero; if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)info[(__bridge NSString*)kCGWindowBounds],&rect) || rect.size.width<=0 || rect.size.height<=0) { CFRelease(ax); error="element_unavailable"; observer_diagnostic("bounds", error); return false; }
  result.target.pid=app.processIdentifier; result.target.window_id=wid; result.target.layer=[info[(__bridge NSString*)kCGWindowLayer] intValue]; result.target.x=rect.origin.x; result.target.y=rect.origin.y; result.target.width=rect.size.width; result.target.height=rect.size.height;
  NSString* window_name = [info[(__bridge NSString*)kCGWindowName] isKindOfClass:[NSString class]] ? info[(__bridge NSString*)kCGWindowName] : @"";
  result.target.owner_name=std::string((app.localizedName ?: @"").UTF8String); result.target.window_name=std::string(window_name.UTF8String);
  result.app=app_info(app); result.process_started=app.launchDate; result.window=std::shared_ptr<void>((void*)ax,[](void* p){ CFRelease(p); }); error.clear(); return true;
}
bool observer_dispatch_eligible(const ObserverWindow& window, std::string& error) {
  // 跨进程 AX getter 返回后只用系统状态、进程与 CG 窗口事实重验，不做 AX RPC 或重建索引。
  if (!window.window || !window.process_started || !window.target.identified()) {
    error="element_unavailable"; return false;
  }
  if (!session_ok(error)) return false;
  NSRunningApplication* app=[NSRunningApplication runningApplicationWithProcessIdentifier:window.target.pid];
  if (!app || app.terminated || app.hidden || app.processIdentifier!=window.target.pid ||
      !observer_same_process(window.process_started,app.launchDate)) {
    error="element_unavailable"; return false;
  }
  NSArray* onscreen=cg_windows(kCGWindowListOptionOnScreenOnly);
  if (!onscreen) { error="broker_unavailable"; return false; }
  NSDictionary* match=nil; size_t matches=0;
  for (NSDictionary* row in onscreen) {
    id pid=row[(__bridge NSString*)kCGWindowOwnerPID];
    id wid=row[(__bridge NSString*)kCGWindowNumber];
    if (![pid isKindOfClass:NSNumber.class] || ![wid isKindOfClass:NSNumber.class]) continue;
    if ([pid intValue]==window.target.pid && [wid unsignedIntValue]==window.target.window_id) {
      match=row; ++matches;
    }
  }
  CGRect bounds=CGRectZero;
  id layer=match[(__bridge NSString*)kCGWindowLayer];
  id rawBounds=match[(__bridge NSString*)kCGWindowBounds];
  if (matches!=1 || ![layer isKindOfClass:NSNumber.class] || [layer intValue]!=0 ||
      ![rawBounds isKindOfClass:NSDictionary.class] ||
      !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)rawBounds,&bounds) ||
      CGRectIsNull(bounds) || CGRectIsEmpty(bounds) || !std::isfinite(bounds.origin.x) ||
      !std::isfinite(bounds.origin.y) || !std::isfinite(bounds.size.width) ||
      !std::isfinite(bounds.size.height) || app.terminated || app.hidden ||
      !observer_same_process(window.process_started,app.launchDate)) {
    error="element_unavailable"; return false;
  }
  if (!session_ok(error)) return false;
  error.clear(); return true;
}
bool observer_read_tree(const ObserverWindow& window, NSMutableArray* elements, NSMutableArray* handles, bool& truncated, std::string& error) {
  truncated=false; if (!window.window || !elements || !handles) { error="structured_state_unavailable"; return false; }
  NSDictionary* ref=@{ @"pid": @(window.target.pid), @"window_id": @(window.target.window_id) }; ObserverWindow before;
  if (!observer_resolve_window(ref,before,error)) { observer_diagnostic("read_resolve_before", error); return false; }
  if (!observer_same_process(window.process_started,before.process_started) ||
      !CFEqual((CFTypeRef)before.window.get(),(CFTypeRef)window.window.get())) { error="stale_state"; return false; }
  auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(10);
  const ObserverAXReader reader={AXUIElementGetPid,
    reinterpret_cast<GetWindow>(dlsym(RTLD_DEFAULT,"_AXUIElementGetWindow")),
    reinterpret_cast<AXError(*)(AXUIElementRef,pid_t*)>(dlsym(RTLD_DEFAULT,"_AXUIElementGetActualPid")),AXUIElementSetMessagingTimeout,AXUIElementCopyAttributeValue,AXUIElementCopyActionNames,observer_system_view_opaque};
  if (!observer_walk_tree((AXUIElementRef)window.window.get(),window.target.pid,window.target.window_id,
            deadline,elements,handles,truncated,error,reader)) return false;
  if (std::chrono::steady_clock::now() >= deadline) { [elements removeAllObjects]; [handles removeAllObjects]; error="timeout"; return false; }
  ObserverWindow after;
  if (!observer_resolve_window(ref,after,error)) { observer_diagnostic("read_resolve_after", error); [elements removeAllObjects]; [handles removeAllObjects]; return false; }
  if (!observer_same_process(window.process_started,after.process_started) ||
      !CFEqual((CFTypeRef)after.window.get(),(CFTypeRef)window.window.get())) { [elements removeAllObjects]; [handles removeAllObjects]; error="stale_state"; return false; }
  error.clear(); return true;
}
}
