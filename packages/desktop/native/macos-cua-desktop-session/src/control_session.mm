#include "control_session.h"
#include "observer_contract.h"
#import <CoreFoundation/CoreFoundation.h>
#import <CommonCrypto/CommonDigest.h>
#include <cstdio>
namespace zody::cua::desktop_session {
namespace {
bool yes(id v) { return v && CFGetTypeID((__bridge CFTypeRef)v)==CFBooleanGetTypeID() && [v boolValue]; }
bool same(const ObserverWindow& a, const ObserverWindow& b) {
  return a.target.pid==b.target.pid && a.target.window_id==b.target.window_id && a.window && b.window &&
    a.process_started && [a.process_started isEqual:b.process_started] &&
    CFEqual(static_cast<CFTypeRef>(a.window.get()),static_cast<CFTypeRef>(b.window.get()));
}
NSString* display(const std::string& raw) {
  NSString* value=[[NSString alloc] initWithBytes:raw.data() length:raw.size() encoding:NSUTF8StringEncoding] ?: @"";
  NSMutableString* safe=[NSMutableString string];
  for (NSUInteger i=0;i<value.length;++i) { unichar c=[value characterAtIndex:i]; if (c>=0x20 && c!=0x7f) [safe appendFormat:@"%C",c]; }
  while ([safe lengthOfBytesUsingEncoding:NSUTF8StringEncoding]>128 && safe.length) [safe deleteCharactersInRange:[safe rangeOfComposedCharacterSequenceAtIndex:safe.length-1]];
  return safe;
}
NSDictionary* target(const ObserverWindow& w) {
  auto& t=w.target;
  NSString* owner=display(t.owner_name);
  NSString* name=display(t.window_name);
  return @{ @"pid":@(t.pid), @"windowId":@(t.window_id), @"layer":@(t.layer), @"x":@(t.x), @"y":@(t.y), @"width":@(t.width), @"height":@(t.height), @"ownerName":owner, @"windowName":name };
}
void audit(const char* event, uint64_t attempt, NSString* scope, const char* status) {
  NSData* bytes=[scope dataUsingEncoding:NSUTF8StringEncoding]; unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes.bytes,static_cast<CC_LONG>(bytes.length),digest);
  char shortHash[17]; for (int i=0;i<8;++i) std::snprintf(shortHash+i*2,3,"%02x",digest[i]);
  std::fprintf(stderr,"[cua-control] {\"event\":\"%s\",\"attempt\":%llu,\"scope\":\"%s\",\"dispatch_status\":\"%s\"}\n",event,static_cast<unsigned long long>(attempt),shortHash,status);
}
NSDictionary* result(NSString* code, NSString* dispatch, NSString* sync, NSDictionary* state=nil) {
  NSMutableDictionary* receipt=[@{ @"action_sent":@(![dispatch isEqual:@"not_sent"]), @"dispatch_status":dispatch, @"state_sync_status":sync } mutableCopy];
  if (code) { receipt[@"code"]=code; receipt[@"message"]=@"Computer use control failed"; }
  NSData* json=[NSJSONSerialization dataWithJSONObject:receipt options:0 error:nil];
  NSMutableDictionary* out=[@{ @"content":@[@{ @"type":@"text", @"text": [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] }] } mutableCopy];
  if (code) out[@"isError"]=@YES;
  if (state) out[@"structuredContent"]=state;
  return out;
}
NSString* code_for(const std::string& error) {
  NSString* code=[NSString stringWithUTF8String:error.c_str()];
  return [@[@"permission_denied",@"stale_state",@"structured_state_unavailable",@"action_unavailable",@"timeout",@"broker_unavailable",@"screen_locked",@"not_authorized",@"invalid_request",@"element_unavailable"] containsObject:code] ? code : @"internal";
}
}
ControlSessionOutcome control_session_run(NSDictionary* request, NSDictionary* scope, ObserverState& state,
    ControlOwner& owner, const ObserverSource& source, const ObserverExchange& exchange,
    const ObserverCancelled& cancelled, ConfirmationController& confirmation, std::string& error,
    const ControlAX& ax, std::function<ControlOwner::Time()> now, ControlDispatchGuard guard) {
  ControlSessionOutcome outcome;
  NSData* scopeBytes=[NSJSONSerialization dataWithJSONObject:scope options:NSJSONWritingSortedKeys error:nil];
  NSString* scopeKey=[[NSString alloc] initWithData:scopeBytes encoding:NSUTF8StringEncoding] ?: @"";
  const std::string scopeString=scopeKey.UTF8String ?: "";
  const uint64_t attempt=owner.reserve_attempt();
  const auto live=[&]() {
    if (cancelled(error)) return false;
    NSDictionary* r=exchange(@"check",scope,error);
    if (![r isKindOfClass:[NSDictionary class]] || !yes(r[@"ok"])) return false;
    for (NSString* k in scope) if (![r[k] isEqual:scope[k]]) return false;
    return [r[@"projection"][@"status"] isEqual:@"candidate"] && [r[@"projection"][@"ref"] isEqual:scope[@"ref"]] && !cancelled(error);
  };
  uint64_t generation=0; bool watch=false;
  const auto send=[&](NSDictionary* value) {
    if (cancelled(error)) { if (watch) owner.invalidate(generation); return false; }
    NSMutableDictionary* payload=[scope mutableCopy]; payload[@"result"]=value;
    if (watch) payload[@"lease_watch"]=@YES;
    NSDictionary* ack=exchange(@"controlResult",payload,error);
    bool ok=[ack isKindOfClass:[NSDictionary class]] && ack.count==(watch?3:2) && yes(ack[@"ok"]) && yes(ack[@"accepted"]) && (!watch || yes(ack[@"lease_watch"])) && !cancelled(error);
    if (!ok && watch) owner.invalidate(generation);
    if (ok && watch) outcome.watch_generation=generation;
    return ok;
  };
  const auto fail=[&](NSString* code) { audit("rejected",attempt,scopeKey,"not_sent"); outcome.delivered=live() && send(result(code,@"not_sent",@"not_requested")); return outcome; };
  if (!control_request_valid(request)) {
    // 中文原因：限定方法的其他参数组合属于尚未支持的动作，不能误报执行或降级派发。
    id method=[request isKindOfClass:[NSDictionary class]] ? request[@"method"] : nil;
    bool known=[method isKindOfClass:[NSString class]] && [@[@"left_click",@"perform_action",@"set_value"] containsObject:method];
    return fail(known ? @"action_unavailable" : @"invalid_request");
  }
  if (!live()) { audit("rejected",attempt,scopeKey,"not_sent"); return outcome; }
  if ([request[@"method"] isEqual:@"stop_computer_control"]) {
    NSData* serialized=[NSJSONSerialization dataWithJSONObject:scope options:NSJSONWritingSortedKeys error:nil];
    NSString* key=[[NSString alloc] initWithData:serialized encoding:NSUTF8StringEncoding];
    if (!key) return fail(@"invalid_request");
    owner.stop_scope(key.UTF8String ?: "");
    outcome.delivered=send(result(nil,@"not_sent",@"not_requested")); return outcome;
  }
  NSDictionary* args=request[@"arguments"];
  ObserverWindow window;
  if (!source.resolve(args[@"app_ref"],window,error)) {
    owner.stop_scope(scopeString); state.clear(); return fail(code_for(error));
  }
  if (!window.window || !window.process_started || !window.target.measured()) {
    owner.stop_scope(scopeString); state.clear(); return fail(@"stale_state");
  }
  NSDictionary* exact=@{ @"pid":@(window.target.pid), @"window_id":@(window.target.window_id) };
  NSDictionary* stateWindow=@{ @"pid":@(window.target.pid), @"window_id":@(window.target.window_id), @"window_id_fallback":@NO };
  NSArray* identity=@[(__bridge id)window.window.get(),window.process_started];
  id handle=state.frozen_handle(scopeKey,stateWindow,identity,args[@"state_id"],[args[@"target"][@"index"] unsignedIntegerValue]);
  if (!handle) return fail(@"stale_state");
  NSMutableDictionary* bind=[scope mutableCopy]; bind[@"target"]=@{ @"pid":@(window.target.pid),@"windowId":@(window.target.window_id) };
  SessionBinding binding;
  if (!parse_session_binding(bind,binding,error)) return fail(@"invalid_request");
  binding.target=window.target;
  const auto confirm=[&](NSString* method) {
    if (!live()) return false;
    uint64_t g=confirmation.begin(binding); if (!g) return false;
    NSMutableDictionary* payload=[scope mutableCopy]; payload[@"generation"]=@(g); payload[@"target"]=target(window);
    NSDictionary* decision=exchange(method,payload,error);
    if (cancelled(error) || ![decision isKindOfClass:[NSDictionary class]] || !yes(decision[@"ok"])) { confirmation.invalidate(g,"control-confirmation-invalid"); return false; }
    bool allowed=yes(decision[@"allowed"]); return confirmation.resolveFromApp(g,allowed) && allowed && live();
  };
  bool read= args[@"return_state"] && ![args[@"return_state"] isEqual:@"none"];
  // 返回状态必须先取得读取授权，控制确认不能代替正文读取授权。
  const bool validateText = [request[@"method"] isEqual:@"set_value"];
  if ((read || validateText) && !confirm(@"confirmRead")) return fail(@"permission_denied");
  if (!confirm(@"confirmControl")) return fail(@"permission_denied");
  ObserverWindow current;
  if (!source.resolve(exact,current,error) || !same(window,current)) {
    owner.stop_scope(scopeString); state.clear(); return fail(@"stale_state");
  }
  ControlAction action=[request[@"method"] isEqual:@"set_value"] ? ControlAction::SetValue : ControlAction::Press;
  AXUIElementRef element=(__bridge AXUIElementRef)handle;
  if (!control_ax_prepare(ax,element,window.target.pid,window.target.window_id,action)) {
    // 首次复验失败同样使旧元素映射失效，恢复后不能复用旧索引或控制租约。
    owner.stop_scope(scopeString); state.clear(); return fail(@"element_unavailable");
  }
  std::string windowString=std::to_string(window.target.pid)+":"+std::to_string(window.target.window_id)+":"+std::to_string([window.process_started timeIntervalSince1970]);
  bool busy=false;
  generation=owner.grant(scopeString,windowString,now(),&watch,window.window,&busy);
  if (!generation) return fail(busy ? @"controller_busy" : @"broker_unavailable");
  // 中文原因：最终复验后独占 reader 负责派发期间的撤销，不能与 exchange 并发读取。
  if (!live() || !source.resolve(exact,current,error) || !same(window,current) || cancelled(error)) {
    owner.stop_scope(scopeString); state.clear(); watch=false; return fail(@"stale_state");
  }
  bool admitted=false, success=false, stillValid=false, invalid_element=false, invalid_eligibility=false;
  std::string eligibility_error="broker_unavailable";
  guard(generation,[&] {
    // 最终 authority 往返期间元素可能迁到同进程兄弟窗口；必须在准入前重验原句柄。
    if (!control_ax_prepare(ax,element,window.target.pid,window.target.window_id,action)) {
      invalid_element=true;
      owner.stop_scope(scopeString);
      state.clear();
      return;
    }
    // 支持性 AX getter 后以非 AX 系统事实再检查当前窗口资格，失效时清除同 scope 旧映射。
    if (!source.dispatch_eligible || !source.dispatch_eligible(window,eligibility_error)) {
      invalid_eligibility=true;
      owner.stop_scope(scopeString);
      state.clear();
      return;
    }
    if (!owner.admit(scopeString,windowString,generation,now())) return;
    admitted=true;
    audit("admitted",attempt,scopeKey,"possibly_sent");
    AXError status=control_ax_send(ax,element,action,(__bridge CFStringRef)args[@"value"]);
    success=status==kAXErrorSuccess;
    stillValid=owner.complete(generation,success,now());
  });
  if (!admitted) {
    if (watch) owner.invalidate(generation); watch=false;
    return fail(invalid_element ? @"element_unavailable" : invalid_eligibility ? code_for(eligibility_error) : @"stale_state");
  }
  if (!stillValid && watch) { owner.invalidate(generation); watch=false; }
  NSString* dispatch=success?@"sent":@"possibly_sent";
  audit("completed",attempt,scopeKey,success?"sent":"possibly_sent");
  NSString* sync=read?@"failed":@"not_requested";
  NSString* code=success?nil:@"action_unavailable";
  ObserverPreparedState pending;
  const auto validOwner=[&]() { return owner.valid(scopeString,windowString,generation,now()); };
  if (read && success && stillValid && validOwner() && live()) {
    NSMutableArray* elements=[NSMutableArray array]; NSMutableArray* handles=[NSMutableArray array]; bool truncated=false;
    if (source.read(window,elements,handles,truncated,error) && validOwner() && live() && source.resolve(exact,current,error) && same(window,current)) {
      pending=state.prepare(scopeKey,window.app,stateWindow,identity,elements,handles,truncated,true,true);
      if (pending.result) sync=@"synced";
    }
  }
  if (read && ![sync isEqual:@"synced"] && !code) code=@"structured_state_unavailable";
  // 中文原因：写后读取与回执互相独立，不能把可能已派发的结果重建成未派发。
  if (!live()) { if (watch) owner.invalidate(generation); return outcome; }
  if ([sync isEqual:@"synced"] && (!validOwner() || !source.resolve(exact,current,error) || !same(window,current) || cancelled(error) || !validOwner())) { sync=@"failed"; code=@"structured_state_unavailable"; state.clear(); }
  if (watch && !validOwner()) { owner.invalidate(generation); watch=false; }
  outcome.delivered=send(result(code,dispatch,sync,[sync isEqual:@"synced"]?pending.result[@"structuredContent"]:nil));
  if (outcome.delivered && [sync isEqual:@"synced"]) state.commit(pending); else if (read) state.clear();
  return outcome;
}
}
