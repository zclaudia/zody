#import <Foundation/Foundation.h>
#include "control_session.h"
#include <cassert>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>
using namespace zody::cua::desktop_session;
namespace zody::cua::desktop_session {
NSArray* observer_list_apps(std::string&) { return nil; }
NSArray* observer_list_windows(id,std::string&) { return nil; }
bool observer_resolve_window(id,ObserverWindow&,std::string&) { return false; }
bool observer_dispatch_eligible(const ObserverWindow&,std::string&) { return false; }
bool observer_read_tree(const ObserverWindow&,NSMutableArray*,NSMutableArray*,bool&,std::string&) { return false; }
}
static std::atomic<int> writes{0};
static std::mutex barrierMutex;
static std::condition_variable barrier;
static bool blockPress=false, enteredPress=false, releasePress=false;
static AXError pid(AXUIElementRef,pid_t* p) { *p=42; return kAXErrorSuccess; }
static std::atomic<uint32_t> element_window{7};
static AXError wid(AXUIElementRef,uint32_t* p) { *p=element_window.load(); return kAXErrorSuccess; }
static int value_reads=0, action_reads=0, mutation=0;
static std::atomic<bool> dispatch_ready{true};
static int blocked_getter=0;
static bool getter_entered=false, getter_released=false;
static void hold_final_getter(int kind, int count) {
  std::unique_lock<std::mutex> lock(barrierMutex);
  if (blocked_getter!=kind || count!=2) return;
  getter_entered=true; barrier.notify_all();
  barrier.wait(lock,[]{ return getter_released; });
}
static AXError attr(AXUIElementRef, CFStringRef key, CFTypeRef* out) {
  if (CFEqual(key,kAXSubroleAttribute)) return kAXErrorNoValue;
  if (CFEqual(key,kAXValueAttribute)) { ++value_reads; hold_final_getter(2,value_reads); if (value_reads==2 && mutation==2) element_window=8; if (value_reads==2 && mutation==4) dispatch_ready=false; *out=CFRetain(CFSTR("")); return kAXErrorSuccess; }
  *out=CFRetain(kAXTextFieldRole); return kAXErrorSuccess;
}
static AXError settable(AXUIElementRef,CFStringRef,Boolean* out) { *out=true; return kAXErrorSuccess; }
static AXError set_value(AXUIElementRef,CFStringRef,CFTypeRef) { ++writes; return kAXErrorSuccess; }
static AXError actions(AXUIElementRef,CFArrayRef* p) { ++action_reads; hold_final_getter(1,action_reads); if (action_reads==2 && mutation==1) element_window=8; if (action_reads==2 && mutation==3) dispatch_ready=false; const void* v[]={kAXPressAction}; *p=CFArrayCreate(nullptr,v,1,&kCFTypeArrayCallBacks); return kAXErrorSuccess; }
static AXError press(AXUIElementRef,CFStringRef) {
  ++writes;
  std::unique_lock<std::mutex> lock(barrierMutex);
  if (blockPress) { enteredPress=true; barrier.notify_all(); barrier.wait(lock,[]{ return releasePress; }); }
  return kAXErrorSuccess;
}
int main() { @autoreleasepool {
  NSDictionary* ref=@{ @"submissionLineageId":@"l",@"appIncarnation":@"a",@"hostInstanceId":@"h",@"runtimeInstanceId":@"r",@"sessionId":@"s",@"workspaceKey":@"w",@"authorizationRevision":@1 };
  NSDictionary* scope=@{ @"traceId":@"t",@"producerIncarnation":@"p",@"runId":@"r",@"turnId":@"u",@"ref":ref };
  NSString* scopeKey=[[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:scope options:NSJSONWritingSortedKeys error:nil] encoding:NSUTF8StringEncoding];
  id native=@"native-window", handle=@"native-element"; NSDate* started=[NSDate dateWithTimeIntervalSince1970:123];
  ObserverWindow window; window.target.pid=42; window.target.window_id=7; window.target.width=100; window.target.height=100; window.target.owner_name="App"; window.target.window_name="Window"; window.process_started=started; window.app=@{ @"pid":@42 }; window.window=std::shared_ptr<void>((__bridge void*)native,[](void*){});
  NSDictionary* win=@{ @"pid":@42,@"window_id":@7,@"window_id_fallback":@NO };
  ObserverState state; auto pending=state.prepare(scopeKey,window.app,win,@[native,started],@[@{ @"index":@0,@"kind":@"button",@"title":@"",@"value":[NSNull null],@"actions":@[@"AXPress"] }],@[handle],false,true,true); assert(pending.result); state.commit(pending);
  NSString* stateID=pending.result[@"structuredContent"][@"state_id"];
  NSDictionary* request=@{ @"method":@"left_click",@"arguments":@{ @"app_ref":@{ @"pid":@42,@"window_id":@7 },@"state_id":stateID,@"target":@{ @"type":@"element",@"index":@0 } } };
  bool resolve_ok=true;
  ObserverSource source; source.resolve=[&](id,ObserverWindow& out,std::string& err) { if (!resolve_ok) { err="element_unavailable"; return false; } out=window; return true; };
  source.read=[](const ObserverWindow&,NSMutableArray*,NSMutableArray*,bool&,std::string&) { return false; };
  source.dispatch_eligible=[](const ObserverWindow&,std::string& err) { if (!dispatch_ready) { err="screen_locked"; return false; } return true; };
  ControlAX ax{pid,pid,wid,attr,actions,settable,press,set_value};
  bool acquired=false; ControlOwner owner([&]{ if(acquired) return false; acquired=true; return true; },[&]{ acquired=false; });
  ConfirmationController confirmation; std::string error; NSMutableArray* confirmOrder=[NSMutableArray array]; int controls=0,reads=0; bool allow=true, allowRead=true, acceptAck=true, watch=false; int writesAtRead=-1; NSDictionary* receipt=nil;
  ObserverExchange exchange=[&](NSString* method,NSDictionary* payload,std::string&) -> NSDictionary* {
    if ([method isEqual:@"check"]) { NSMutableDictionary* r=[scope mutableCopy]; r[@"ok"]=@YES; r[@"projection"]=@{ @"status":@"candidate",@"ref":ref }; return r; }
    if ([method isEqual:@"confirmControl"] || [method isEqual:@"confirmRead"]) { [confirmOrder addObject:method]; if ([method isEqual:@"confirmControl"]) ++controls; else { ++reads; writesAtRead=writes.load(); } return @{ @"ok":@YES,@"allowed":@(allow && ([method isEqual:@"confirmControl"] || allowRead)) }; }
    if ([method isEqual:@"controlResult"]) { watch=payload[@"lease_watch"]!=nil; receipt=payload[@"result"]; if (!acceptAck) return @{ @"ok":@NO }; return watch?@{ @"ok":@YES,@"accepted":@YES,@"lease_watch":@YES }:@{ @"ok":@YES,@"accepted":@YES }; }
    return nil;
  };
  ObserverCancelled cancelled=[](std::string&) { return false; };
  allow=false; auto denied=control_session_run(request,scope,state,owner,source,exchange,cancelled,confirmation,error,ax); assert(denied.delivered && writes==0 && !acquired);
  allow=true; auto sent=control_session_run(request,scope,state,owner,source,exchange,cancelled,confirmation,error,ax); assert(sent.delivered && sent.watch_generation && watch && writes==1 && acquired);
  auto reused=control_session_run(request,scope,state,owner,source,exchange,cancelled,confirmation,error,ax); assert(reused.delivered && !reused.watch_generation && !watch && writes==2);
  NSMutableDictionary* changed=[request mutableCopy]; NSMutableDictionary* args=[request[@"arguments"] mutableCopy]; args[@"state_id"]=@"stale"; changed[@"arguments"]=args;
  auto stale=control_session_run(changed,scope,state,owner,source,exchange,cancelled,confirmation,error,ax); assert(stale.delivered && writes==2);
  args=[request[@"arguments"] mutableCopy]; args[@"return_state"]=@"full"; changed[@"arguments"]=args;
  [confirmOrder removeAllObjects];
  auto failedRead=control_session_run(changed,scope,state,owner,source,exchange,cancelled,confirmation,error,ax); assert(failedRead.delivered && writes==3 && reads==1 && writesAtRead==2 && [receipt[@"isError"] boolValue]);
  assert(([confirmOrder isEqual:@[@"confirmRead", @"confirmControl"]]));
  resolve_ok=false;
  auto lost=control_session_run(request,scope,state,owner,source,exchange,cancelled,confirmation,error,ax);
  assert(lost.delivered && !acquired);
  resolve_ok=true;
  owner.stop(); assert(!acquired);
  // Restore the frozen map after the unsuccessful post-write read cleared it.
  pending=state.prepare(scopeKey,window.app,win,@[native,started],@[@{ @"index":@0,@"kind":@"button",@"title":@"",@"value":[NSNull null],@"actions":@[@"AXPress"] }],@[handle],false,true,true);
  assert(pending.result); state.commit(pending);
  stateID=pending.result[@"structuredContent"][@"state_id"];
  NSMutableDictionary* baseArgs=[request[@"arguments"] mutableCopy]; baseArgs[@"state_id"]=stateID;
  request=@{ @"method":@"left_click",@"arguments":baseArgs };
  int before=writes.load();
  NSMutableDictionary* readArgs=[baseArgs mutableCopy]; readArgs[@"return_state"]=@"full";
  NSDictionary* readRequest=@{ @"method":@"left_click",@"arguments":readArgs };
  allowRead=false;
  auto readDenied=control_session_run(readRequest,scope,state,owner,source,exchange,cancelled,confirmation,error,ax);
  assert(readDenied.delivered && writes==before && writesAtRead==before && !acquired);
  NSDictionary* valueRequest=@{ @"method":@"set_value", @"arguments":@{ @"app_ref":baseArgs[@"app_ref"], @"state_id":stateID, @"target":baseArgs[@"target"], @"value":@"new" } };
  auto valueDenied=control_session_run(valueRequest,scope,state,owner,source,exchange,cancelled,confirmation,error,ax);
  assert(valueDenied.delivered && value_reads==0 && writes==before && !acquired);
  allowRead=true;
  auto valueAllowed=control_session_run(valueRequest,scope,state,owner,source,exchange,cancelled,confirmation,error,ax);
  assert(valueAllowed.delivered && value_reads==2 && writes==before+1);
  owner.stop(); before=writes.load();
  // Unknown and unsupported targets/strategies cannot invoke AX.
  for (NSDictionary* bad in @[
    @{ @"method":@"scroll",@"arguments":baseArgs },
    @{ @"method":@"left_click",@"arguments":@{ @"app_ref":baseArgs[@"app_ref"],@"state_id":stateID,@"target":@{ @"type":@"coordinate",@"x":@1,@"y":@1 } } },
    @{ @"method":@"left_click",@"arguments":@{ @"app_ref":baseArgs[@"app_ref"],@"state_id":stateID,@"target":baseArgs[@"target"],@"strategy":@"event" } }
  ]) { auto rejected=control_session_run(bad,scope,state,owner,source,exchange,cancelled,confirmation,error,ax); assert(rejected.delivered && writes==before && !acquired); }
  auto clock=[] { return std::chrono::steady_clock::now(); };
  // Stop wins gate admission: the closure executes but no AX dispatch occurs.
  ControlDispatchGuard stopFirst=[&](uint64_t, const std::function<void()>& fn) { owner.stop(); fn(); };
  auto stoppedFirst=control_session_run(request,scope,state,owner,source,exchange,cancelled,confirmation,error,ax,clock,stopFirst);
  assert(stoppedFirst.delivered && writes==before && !acquired && !stoppedFirst.watch_generation);
  // Admission wins; hold the native reply while Stop invalidates the owner.
  blockPress=true; enteredPress=false; releasePress=false;
  ControlDispatchGuard stopDuring=[&](uint64_t, const std::function<void()>& fn) {
    std::thread worker([&]{ @autoreleasepool { fn(); } });
    { std::unique_lock<std::mutex> lock(barrierMutex); barrier.wait(lock,[]{ return enteredPress; }); }
    owner.stop(); assert(acquired); // in-flight AX retains the machine lease
    { std::lock_guard<std::mutex> lock(barrierMutex); releasePress=true; } barrier.notify_all();
    worker.join();
  };
  auto late=control_session_run(request,scope,state,owner,source,exchange,cancelled,confirmation,error,ax,clock,stopDuring);
  blockPress=false;
  assert(late.delivered && writes==before+1 && !late.watch_generation && !acquired);
  NSDictionary* lateReceipt=[NSJSONSerialization JSONObjectWithData:[receipt[@"content"][0][@"text"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  assert([lateReceipt[@"action_sent"] boolValue] && [lateReceipt[@"dispatch_status"] isEqual:@"sent"]);
  // A newly acquired lease is invalidated if its watcher ACK is rejected.
  acceptAck=false;
  auto ackRejected=control_session_run(request,scope,state,owner,source,exchange,cancelled,confirmation,error,ax);
  assert(!ackRejected.delivered && !ackRejected.watch_generation && !acquired && writes==before+2);
  acceptAck=true;
  // 首次校验发现元素移窗时必须撤销现有租约，恢复后旧 state/index 仍不能派发。
  auto active=control_session_run(request,scope,state,owner,source,exchange,cancelled,confirmation,error,ax);
  assert(active.delivered && acquired);
  int beforeInitialFailure=writes.load(); element_window=8;
  auto firstFailure=control_session_run(request,scope,state,owner,source,exchange,cancelled,confirmation,error,ax);
  assert(firstFailure.delivered && writes==beforeInitialFailure && !acquired);
  element_window=7;
  auto restoredOld=control_session_run(request,scope,state,owner,source,exchange,cancelled,confirmation,error,ax);
  assert(restoredOld.delivered && writes==beforeInitialFailure && !acquired);
  pending=state.prepare(scopeKey,window.app,win,@[native,started],@[@{ @"index":@0,@"kind":@"button",@"title":@"",@"value":[NSNull null],@"actions":@[@"AXPress"] }],@[handle],false,true,true);
  assert(pending.result); state.commit(pending);
  stateID=pending.result[@"structuredContent"][@"state_id"];
  baseArgs=[request[@"arguments"] mutableCopy]; baseArgs[@"state_id"]=stateID;
  request=@{ @"method":@"left_click", @"arguments":baseArgs };
  // 元素在最后 authority/window 往返后迁到同 PID 的兄弟窗口，必须零派发。
  auto moved_guard=[&](uint64_t, const std::function<void()>& fn) { element_window=8; fn(); };
  int beforeMove=writes.load();
  auto moved=control_session_run(request,scope,state,owner,source,exchange,cancelled,confirmation,error,ax,clock,moved_guard);
  assert(moved.delivered && writes==beforeMove && !acquired);
  NSDictionary* movedReceipt=[NSJSONSerialization JSONObjectWithData:[receipt[@"content"][0][@"text"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  assert([movedReceipt[@"dispatch_status"] isEqual:@"not_sent"] && [movedReceipt[@"code"] isEqual:@"element_unavailable"]);
  element_window=7;
  pending=state.prepare(scopeKey,window.app,win,@[native,started],@[@{ @"index":@0,@"kind":@"AXTextField",@"title":@"",@"value":[NSNull null],@"actions":@[] }],@[handle],false,true,true);
  assert(pending.result); state.commit(pending);
  NSString* newState=pending.result[@"structuredContent"][@"state_id"];
  NSDictionary* movedValue=@{ @"method":@"set_value", @"arguments":@{ @"app_ref":baseArgs[@"app_ref"], @"state_id":newState, @"target":baseArgs[@"target"], @"value":@"new" } };
  auto movedSet=control_session_run(movedValue,scope,state,owner,source,exchange,cancelled,confirmation,error,ax,clock,moved_guard);
  assert(movedSet.delivered && writes==beforeMove && !acquired);
  movedReceipt=[NSJSONSerialization JSONObjectWithData:[receipt[@"content"][0][@"text"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  assert([movedReceipt[@"dispatch_status"] isEqual:@"not_sent"] && [movedReceipt[@"code"] isEqual:@"element_unavailable"]);
  element_window=7;
  // 最终能力 getter 阻塞期间发生移窗或系统资格失效，均不得入 gate。
  for (int mode : {1,2,3,4}) {
    pending=state.prepare(scopeKey,window.app,win,@[native,started],@[@{ @"index":@0,@"kind":@"button",@"title":@"",@"value":[NSNull null],@"actions":@[@"AXPress"] }],@[handle],false,true,true);
    assert(pending.result); state.commit(pending);
    NSString* idValue=pending.result[@"structuredContent"][@"state_id"];
    NSMutableDictionary* values=[baseArgs mutableCopy]; values[@"state_id"]=idValue;
    if (mode==2 || mode==4) values[@"value"]=@"new";
    NSDictionary* call=@{ @"method": (mode==2 || mode==4 ? @"set_value" : @"left_click"), @"arguments": values };
    mutation=mode; action_reads=0; value_reads=0; dispatch_ready=true; element_window=7;
    int prior=writes.load();
    auto outcome=control_session_run(call,scope,state,owner,source,exchange,cancelled,confirmation,error,ax);
    assert(outcome.delivered && writes==prior && !acquired);
    NSDictionary* r=[NSJSONSerialization JSONObjectWithData:[receipt[@"content"][0][@"text"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    assert([r[@"dispatch_status"] isEqual:@"not_sent"]);
    assert([r[@"code"] isEqual:(mode<=2 ? @"element_unavailable" : @"screen_locked")]);
    mutation=0; element_window=7; dispatch_ready=true;
    auto retry=control_session_run(call,scope,state,owner,source,exchange,cancelled,confirmation,error,ax);
    assert(retry.delivered && writes==prior && !acquired);
  }
  // 真正阻塞最终 getter：在调用未返回时改变直接窗口或系统资格。
  for (int mode : {1,2,3,4}) {
    pending=state.prepare(scopeKey,window.app,win,@[native,started],@[@{ @"index":@0,@"kind":@"button",@"title":@"",@"value":[NSNull null],@"actions":@[@"AXPress"] }],@[handle],false,true,true);
    assert(pending.result); state.commit(pending);
    NSString* idValue=pending.result[@"structuredContent"][@"state_id"];
    NSMutableDictionary* values=[baseArgs mutableCopy]; values[@"state_id"]=idValue;
    if (mode==2 || mode==4) values[@"value"]=@"new";
    NSDictionary* call=@{ @"method": (mode==2 || mode==4 ? @"set_value" : @"left_click"), @"arguments": values };
    action_reads=0; value_reads=0; dispatch_ready=true; element_window=7; mutation=0;
    { std::lock_guard<std::mutex> lock(barrierMutex); blocked_getter=(mode==2 || mode==4) ? 2 : 1; getter_entered=false; getter_released=false; }
    int prior=writes.load(); ControlSessionOutcome outcome;
    std::thread worker([&]{ @autoreleasepool { outcome=control_session_run(call,scope,state,owner,source,exchange,cancelled,confirmation,error,ax); } });
    { std::unique_lock<std::mutex> lock(barrierMutex); barrier.wait(lock,[]{ return getter_entered; }); }
    if (mode<=2) element_window=8; else dispatch_ready=false;
    { std::lock_guard<std::mutex> lock(barrierMutex); getter_released=true; } barrier.notify_all();
    worker.join();
    assert(outcome.delivered && writes==prior && !acquired);
    NSDictionary* r=[NSJSONSerialization JSONObjectWithData:[receipt[@"content"][0][@"text"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    assert([r[@"dispatch_status"] isEqual:@"not_sent"]);
    assert([r[@"code"] isEqual:(mode<=2 ? @"element_unavailable" : @"screen_locked")]);
    { std::lock_guard<std::mutex> lock(barrierMutex); blocked_getter=0; }
    element_window=7; dispatch_ready=true;
    auto retry=control_session_run(call,scope,state,owner,source,exchange,cancelled,confirmation,error,ax);
    assert(retry.delivered && writes==prior && !acquired);
  }
  // 缺少最终系统资格实现必须 fail-closed，不能把 mock 的缺省视为允许。
  pending=state.prepare(scopeKey,window.app,win,@[native,started],@[@{ @"index":@0,@"kind":@"button",@"title":@"",@"value":[NSNull null],@"actions":@[@"AXPress"] }],@[handle],false,true,true);
  assert(pending.result); state.commit(pending);
  NSMutableDictionary* noReadyArgs=[baseArgs mutableCopy]; noReadyArgs[@"state_id"]=pending.result[@"structuredContent"][@"state_id"];
  NSDictionary* noReady=@{ @"method":@"left_click", @"arguments":noReadyArgs };
  source.dispatch_eligible={}; int prior=writes.load();
  auto unavailable=control_session_run(noReady,scope,state,owner,source,exchange,cancelled,confirmation,error,ax);
  assert(unavailable.delivered && writes==prior && !acquired);
  NSDictionary* unavailableReceipt=[NSJSONSerialization JSONObjectWithData:[receipt[@"content"][0][@"text"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  assert([unavailableReceipt[@"dispatch_status"] isEqual:@"not_sent"] && [unavailableReceipt[@"code"] isEqual:@"broker_unavailable"]);
} }
