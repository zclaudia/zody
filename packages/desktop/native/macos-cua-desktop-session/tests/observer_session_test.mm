#import <Foundation/Foundation.h>
#include "observer_session.h"
#include <cassert>
#include <initializer_list>
using namespace zody::cua::desktop_session;
static void commit_state_contract() {
  NSDictionary* ref=@{ @"submissionLineageId":@"line", @"appIncarnation":@"app", @"hostInstanceId":@"host", @"runtimeInstanceId":@"runtime", @"sessionId":@"session", @"workspaceKey":@"workspace", @"authorizationRevision":@1 };
  NSDictionary* scope=@{ @"ref":ref, @"traceId":@"trace", @"producerIncarnation":@"producer", @"runId":@"run", @"turnId":@"turn" };
  NSMutableDictionary* boot=[scope mutableCopy]; boot[@"ok"]=@YES; boot[@"projection"]=@{ @"status":@"candidate", @"ref":ref };
  NSDictionary* appRef=@{ @"pid":@12, @"window_id":@34 };
  NSObject* native=[NSObject new]; NSObject* element=[NSObject new]; NSDate* start=[NSDate dateWithTimeIntervalSince1970:1];
  ObserverSource source;
  source.resolve=[&](id, ObserverWindow& w, std::string&) { w.target.pid=12; w.target.window_id=34; w.target.width=100; w.target.height=100; w.app=@{ @"pid":@12 }; w.process_started=start; w.window=std::shared_ptr<void>((__bridge void*)native,[](void*){}); return true; };
  source.read=[&](const ObserverWindow&, NSMutableArray* elements, NSMutableArray* handles, bool&, std::string&) { [elements addObject:@{ @"index":@0, @"kind":@"AXButton" }]; [handles addObject:element]; return true; };
  ObserverSession session(source); ConfirmationController confirmation; std::string error; NSDictionary* last=nil; bool accept=true;
  ObserverExchange exchange=[&](NSString* method, NSDictionary* payload, std::string&) -> NSDictionary* {
    if ([method isEqual:@"check"]) { NSMutableDictionary* r=[scope mutableCopy]; r[@"ok"]=@YES; r[@"projection"]=boot[@"projection"]; return r; }
    if ([method isEqual:@"confirmRead"]) return @{ @"ok":@YES, @"allowed":@YES };
    if ([method isEqual:@"observationResult"]) { last=payload[@"result"]; return @{ @"ok":@YES, @"accepted":@(accept) }; }
    return nil;
  };
  auto cancelled=[](std::string&){ return false; };
  boot[@"observation"]=@{ @"method":@"get_app_state", @"arguments":@{ @"app_ref":appRef, @"tree_shown_to_model":@NO } };
  assert(session.run(boot,"producer",exchange,cancelled,confirmation,error));
  NSString* stateID=last[@"structuredContent"][@"state_id"];
  boot[@"observation"]=@{ @"method":@"commit_state", @"arguments":@{ @"app_ref":appRef, @"state_id":stateID } };
  assert(session.run(boot,"producer",exchange,cancelled,confirmation,error));
  NSDictionary* receipt=[NSJSONSerialization JSONObjectWithData:[last[@"content"][0][@"text"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  assert([receipt[@"committed"] boolValue] && [receipt[@"state_id"] isEqual:stateID] && last[@"structuredContent"]==nil);
  boot[@"observation"]=@{ @"method":@"get_app_state", @"arguments":@{ @"app_ref":appRef } };
  assert(session.run(boot,"producer",exchange,cancelled,confirmation,error));
  assert([last[@"structuredContent"][@"snapshot_mode"] isEqual:@"diff"] && [last[@"structuredContent"][@"base_state_id"] isEqual:stateID]);
  boot[@"observation"]=@{ @"method":@"get_app_state", @"arguments":@{ @"app_ref":appRef, @"tree_shown_to_model":@NO } };
  assert(session.run(boot,"producer",exchange,cancelled,confirmation,error)); stateID=last[@"structuredContent"][@"state_id"];
  boot[@"observation"]=@{ @"method":@"commit_state", @"arguments":@{ @"app_ref":appRef, @"state_id":stateID } };
  accept=false; assert(!session.run(boot,"producer",exchange,cancelled,confirmation,error)); accept=true;
  boot[@"observation"]=@{ @"method":@"get_app_state", @"arguments":@{ @"app_ref":appRef } };
  assert(session.run(boot,"producer",exchange,cancelled,confirmation,error));
  assert([last[@"structuredContent"][@"snapshot_mode"] isEqual:@"full"]);
}
static void remote_association_contract() {
  NSDictionary* ref=@{ @"submissionLineageId":@"line", @"appIncarnation":@"app", @"hostInstanceId":@"host", @"runtimeInstanceId":@"runtime", @"sessionId":@"session", @"workspaceKey":@"identity", @"authorizationRevision":@1 };
  NSDictionary* scope=@{ @"ref":ref, @"traceId":@"trace", @"producerIncarnation":@"producer", @"runId":@"run", @"turnId":@"turn", @"workspaceIdentity":@"identity", @"remoteSessionId":@"remote" };
  NSMutableDictionary* boot=[scope mutableCopy]; boot[@"ok"]=@YES; boot[@"projection"]=@{ @"status":@"candidate", @"ref":ref }; boot[@"observation"]=@{ @"method":@"list_apps", @"arguments":@{} };
  ObserverSource source; source.apps=[](std::string&) { return @[]; };
  ObserverSession session(source); ConfirmationController confirmation; std::string error;
  int checks=0;
  ObserverExchange exchange=[&](NSString* method, NSDictionary* payload, std::string&) -> NSDictionary* {
    assert([payload[@"workspaceIdentity"] isEqual:@"identity"] && [payload[@"remoteSessionId"] isEqual:@"remote"]);
    if ([method isEqual:@"check"]) { ++checks; NSMutableDictionary* r=[scope mutableCopy]; r[@"ok"]=@YES; r[@"projection"]=boot[@"projection"]; return r; }
    if ([method isEqual:@"observationResult"]) return @{ @"ok":@YES, @"accepted":@YES };
    return nil;
  };
  assert(session.run(boot,"producer",exchange,[](std::string&){ return false; },confirmation,error));
  assert(checks>=1);
  boot[@"workspaceIdentity"]=@"different";
  assert(!session.run(boot,"producer",exchange,[](std::string&){ return false; },confirmation,error));
  boot[@"workspaceIdentity"]=@"identity";
  boot[@"remoteSessionId"]=@"";
  assert(!session.run(boot,"producer",exchange,[](std::string&){ return false; },confirmation,error));
}
static void lifecycle_contract() {
  NSDictionary* ref=@{ @"submissionLineageId":@"line", @"appIncarnation":@"app", @"hostInstanceId":@"host", @"runtimeInstanceId":@"runtime", @"sessionId":@"session", @"workspaceKey":@"workspace", @"authorizationRevision":@1 };
  NSDictionary* scope=@{ @"ref":ref, @"traceId":@"trace", @"producerIncarnation":@"producer", @"runId":@"run", @"turnId":@"turn" };
  NSMutableDictionary* boot=[scope mutableCopy]; boot[@"ok"]=@YES; boot[@"projection"]=@{ @"status":@"candidate", @"ref":ref };
  auto set_window=[&](int wid) { boot[@"observation"]=@{ @"method":@"get_app_state", @"arguments":@{ @"app_ref":@{ @"pid":@12, @"window_id":@(wid) } } }; };
  bool rebuilt=false, cancel=false, inject_rebuild=false, inject_cancel=false;
  int confirmations=0, reads=0, body_reads=0, delivered=0;
  NSDictionary *last=nil; NSObject *oldIdentity=[NSObject new], *newIdentity=[NSObject new];
  ObserverSource source;
  source.resolve=[&](id ref_arg, ObserverWindow& out, std::string& err) {
    int wid=[ref_arg[@"window_id"] intValue]; if (rebuilt && wid==34) { err="element_unavailable"; return false; }
    out.target.pid=12; out.target.window_id=wid; out.target.width=100; out.target.height=100;
    out.process_started=[NSDate dateWithTimeIntervalSince1970:1]; out.app=@{ @"pid":@12, @"name":@"fixture", @"bundle_id":@"fixture" };
    out.window=std::shared_ptr<void>((__bridge void*)(wid==34 ? oldIdentity : newIdentity),[](void*){}); return true;
  };
  source.read=[&](const ObserverWindow& w, NSMutableArray* elements, NSMutableArray* handles, bool&, std::string& err) {
    ++reads; if (rebuilt && w.target.window_id==34) { err="stale_state"; return false; }
    ++body_reads; [elements addObject:@{ @"index":@0, @"kind":@"AXStaticText", @"title":@"marker", @"value":[NSNull null], @"actions":@[] }];
    [handles addObject:(__bridge id)w.window.get()]; return true;
  };
  ObserverSession session(source); ConfirmationController confirmation; std::string error;
  ObserverExchange exchange=[&](NSString* method, NSDictionary* payload, std::string&) -> NSDictionary* {
    if ([method isEqual:@"check"]) { NSMutableDictionary* response=[scope mutableCopy]; response[@"ok"]=@YES; response[@"projection"]=boot[@"projection"]; return response; }
    if ([method isEqual:@"confirmRead"]) { ++confirmations; if(inject_rebuild) rebuilt=true; if(inject_cancel) cancel=true; return @{ @"ok":@YES, @"allowed":@YES }; }
    if ([method isEqual:@"observationResult"]) { last=payload[@"result"]; if (!last[@"isError"]) ++delivered; return @{ @"ok":@YES, @"accepted":@YES }; }
    return nil;
  };
  auto canceled=[&](std::string&) { return cancel; };
  set_window(34); assert(session.run(boot,"producer",exchange,canceled,confirmation,error)); assert(delivered==1 && body_reads==1);
  inject_cancel=true; assert(!session.run(boot,"producer",exchange,canceled,confirmation,error)); assert(body_reads==1 && reads==1 && delivered==1);
  inject_cancel=false; cancel=false; inject_rebuild=true;
  assert(session.run(boot,"producer",exchange,canceled,confirmation,error));
  assert(reads==2 && body_reads==1 && delivered==1 && [last[@"isError"] boolValue]);
  assert([last[@"content"][0][@"text"] containsString:@"stale_state"]);
  inject_rebuild=false; int old_confirmations=confirmations;
  assert(session.run(boot,"producer",exchange,canceled,confirmation,error));
  assert(confirmations==old_confirmations && body_reads==1 && [last[@"isError"] boolValue]);
  set_window(35); assert(session.run(boot,"producer",exchange,canceled,confirmation,error));
  assert(confirmations==old_confirmations+1 && body_reads==2 && delivered==2);
  assert([last[@"structuredContent"][@"snapshot_mode"] isEqual:@"full"]);
}
int main() {
  @autoreleasepool {
    commit_state_contract();
    remote_association_contract();
    lifecycle_contract();
    NSDictionary* ref = @{ @"submissionLineageId": @"line", @"appIncarnation": @"app", @"hostInstanceId": @"host", @"runtimeInstanceId": @"runtime", @"sessionId": @"session", @"workspaceKey": @"workspace", @"authorizationRevision": @1 };
    NSDictionary* scope = @{ @"ref": ref, @"traceId": @"trace", @"producerIncarnation": @"producer", @"runId": @"run", @"turnId": @"turn" };
    NSMutableDictionary* bootstrap = [scope mutableCopy];
    bootstrap[@"ok"] = @YES;
    bootstrap[@"projection"] = @{ @"status": @"candidate", @"ref": ref };
    bootstrap[@"observation"] = @{ @"method": @"get_app_state", @"arguments": @{ @"app_ref": @{ @"pid": @12, @"window_id": @34 } } };
    bool allowed = false, revoked = false, accepted = true;
    NSDictionary* last_state = nil;
    NSDictionary* last_result = nil;
    int reads = 0, deliveries = 0, checks_after_read = 0;
    bool cancel_at_final_resolve = false, cancel_at_ack = false;
    int inject = 0; bool after_read = false, changed = false;
    NSString* last_error = nil;
    NSObject* identity = [NSObject new];
    ObserverSource source;
    source.resolve = [&](id, ObserverWindow& out, std::string& resolve_error) {
      if (cancel_at_final_resolve && after_read && checks_after_read == 2) revoked = true;
      if (changed && inject == 1) { resolve_error = "screen_locked"; return false; }
      out.target.pid = 12; out.target.window_id = 34; out.target.width = 100; out.target.height = 100;
      out.app = @{ @"pid": @12, @"name": @"fixture", @"bundle_id": @"test.fixture" };
      out.process_started = [NSDate dateWithTimeIntervalSince1970:changed && inject == 2 ? 2 : 1];
      out.window = std::shared_ptr<void>((__bridge void*)identity, [](void*) {});
      return true;
    };
    source.read = [&](const ObserverWindow&, NSMutableArray* elements, NSMutableArray* handles, bool&, std::string&) {
      ++reads; after_read = true; checks_after_read = 0;
      [elements addObject:@{ @"index": @0, @"kind": @"AXButton", @"title": @"fixture", @"value": [NSNull null], @"actions": @[@"AXPress"] }];
      [handles addObject:identity];
      return true;
    };
    ObserverSession session(source);
    ConfirmationController confirmation;
    ObserverExchange exchange = [&](NSString* method, NSDictionary* payload, std::string&) -> NSDictionary* {
      if ([method isEqual:@"confirmRead"]) return @{ @"ok": @YES, @"allowed": @(allowed) };
      if ([method isEqual:@"check"]) {
        if (after_read && ++checks_after_read == 2 && inject) changed = true;
        if (revoked) return @{ @"ok": @NO };
        NSMutableDictionary* response = [scope mutableCopy];
        response[@"ok"] = @YES; response[@"projection"] = bootstrap[@"projection"];
        return response;
      }
      if ([method isEqual:@"observationResult"]) {
        if (cancel_at_ack) revoked = true;
        last_result = payload[@"result"];
        if (payload[@"result"][@"isError"]) last_error = payload[@"result"][@"content"][0][@"text"];
        if (!payload[@"result"][@"isError"]) {
          last_state = payload[@"result"][@"structuredContent"];
          if (accepted) ++deliveries;
        }
        return @{ @"ok": @YES, @"accepted": @(accepted) };
      }
      return nil;
    };
    std::string error;
    auto cancelled = [&](std::string&) { return revoked; };
    assert(session.run(bootstrap, "producer", exchange, cancelled, confirmation, error));
    assert(reads == 0 && deliveries == 0);
    allowed = true;
    assert(session.run(bootstrap, "producer", exchange, cancelled, confirmation, error));
    assert(reads == 1 && deliveries == 1);
    accepted = false;
    assert(!session.run(bootstrap, "producer", exchange, cancelled, confirmation, error));
    assert(reads == 2 && deliveries == 1);
    accepted = true;
    assert(session.run(bootstrap, "producer", exchange, cancelled, confirmation, error));
    assert([last_state[@"snapshot_mode"] isEqual:@"full"]);
    assert(reads == 3 && deliveries == 2);
    for (int scenario : {1, 2}) {
      inject = scenario; changed = false; after_read = false; last_error = nil;
      int prior_deliveries = deliveries;
      assert(session.run(bootstrap, "producer", exchange, cancelled, confirmation, error));
      assert(deliveries == prior_deliveries && last_error);
      assert([last_error containsString:scenario == 1 ? @"screen_locked" : @"stale_state"]);
      inject = 0; changed = false; after_read = false;
      assert(session.run(bootstrap, "producer", exchange, cancelled, confirmation, error));
      assert([last_state[@"snapshot_mode"] isEqual:@"full"]);
    }
    // 中文原因：最终窗口复核可能阻塞 AX；期间收到取消，不能把已采集正文发出或提交基线。
    for (bool during_ack : {false, true}) {
      cancel_at_final_resolve = !during_ack; cancel_at_ack = during_ack;
      after_read = false; int before = deliveries;
      assert(!session.run(bootstrap, "producer", exchange, cancelled, confirmation, error));
      assert(deliveries == before + (during_ack ? 1 : 0));
      cancel_at_final_resolve = false; cancel_at_ack = false; revoked = false; after_read = false;
      assert(session.run(bootstrap, "producer", exchange, cancelled, confirmation, error));
      assert([last_state[@"snapshot_mode"] isEqual:@"full"]);
    }
    // 元数据是完整数组，大小按整个结果的 UTF-8 JSON 计量。
    NSUInteger metadata_length = 19600;
    source.apps = [&](std::string&) { return @[[ @"a" stringByPaddingToLength:metadata_length withString:@"a" startingAtIndex:0 ]]; };
    ObserverSession metadata_session(source);
    bootstrap[@"observation"] = @{ @"method": @"list_apps", @"arguments": @{} };
    last_error = nil;
    assert(metadata_session.run(bootstrap, "producer", exchange, cancelled, confirmation, error));
    assert(!last_error);
    NSArray* decoded = [NSJSONSerialization JSONObjectWithData:[last_result[@"content"][0][@"text"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    assert(decoded.count == 1 && [decoded[0] length] == 19600);
    NSUInteger overhead = [NSJSONSerialization dataWithJSONObject:@{ @"content": @[@{ @"type": @"text", @"text": @"[\"\"]" }] } options:0 error:nil].length;
    metadata_length = 65536 - overhead;
    last_error = nil;
    assert(metadata_session.run(bootstrap, "producer", exchange, cancelled, confirmation, error));
    assert(!last_error && [NSJSONSerialization dataWithJSONObject:last_result options:0 error:nil].length == 65536);
    ++metadata_length;
    last_error = nil;
    assert(metadata_session.run(bootstrap, "producer", exchange, cancelled, confirmation, error));
    assert([last_error containsString:@"structured_state_unavailable"]);
    metadata_length = 65536;
    last_error = nil;
    assert(metadata_session.run(bootstrap, "producer", exchange, cancelled, confirmation, error));
    assert([last_error containsString:@"structured_state_unavailable"]);
    bootstrap[@"observation"] = @{ @"method": @"get_app_state", @"arguments": @{ @"app_ref": @{ @"pid": @12, @"window_id": @34 } } };
    int before_revocation = reads, deliveries_before_revocation = deliveries;
    source.read = [&](const ObserverWindow&, NSMutableArray*, NSMutableArray*, bool&, std::string&) { ++reads; revoked = true; return true; };
    ObserverSession revoked_session(source);
    assert(!revoked_session.run(bootstrap, "producer", exchange, cancelled, confirmation, error));
    assert(reads == before_revocation + 1 && deliveries == deliveries_before_revocation);
    revoked = false;
    assert(!session.run(bootstrap, "another-producer", exchange, cancelled, confirmation, error));
    assert(reads == before_revocation + 1);
    puts("observer-session: passed");
  }
}
