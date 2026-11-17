#import <Foundation/Foundation.h>
#include "session_binding.h"
#include "control_owner.h"
#include <cassert>
using namespace zody::cua::desktop_session;
static NSString* key(NSDictionary* d) {
  NSData* data=[NSJSONSerialization dataWithJSONObject:d options:NSJSONWritingSortedKeys error:nil];
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}
int main() { @autoreleasepool {
  NSDictionary* ref=@{ @"submissionLineageId":@"line", @"authorizationRevision":@1, @"appIncarnation":@"app", @"hostInstanceId":@"host", @"runtimeInstanceId":@"runtime", @"sessionId":@"session", @"workspaceKey":@"identity" };
  NSDictionary* scope=@{ @"ref":ref, @"traceId":@"trace", @"producerIncarnation":@"producer", @"runId":@"run", @"turnId":@"turn", @"workspaceIdentity":@"identity", @"remoteSessionId":@"remote" };
  NSMutableDictionary* bootstrap=[scope mutableCopy]; bootstrap[@"target"]=@{ @"pid":@12, @"windowId":@34 };
  SessionBinding binding; std::string error; assert(parse_session_binding(bootstrap,binding,error));
  NSDictionary* capture=session_association_dictionary(binding);
  assert([key(capture) isEqual:key(scope)]);
  bool held=false; ControlOwner owner([&]{held=true;return true;},[&]{held=false;});
  using Clock=std::chrono::steady_clock; auto now=Clock::time_point{};
  auto generation=owner.grant(key(scope).UTF8String,"window",now); assert(generation && held);
  uint64_t borrowed=0; assert(owner.begin_borrow(key(capture).UTF8String,now+std::chrono::seconds(119),borrowed));
  assert(!owner.finish_borrow(borrowed,true,now+std::chrono::seconds(119)));
  assert(!owner.live(generation,now+std::chrono::seconds(120)) && !held);
  NSMutableDictionary* local=[scope mutableCopy]; [local removeObjectForKey:@"remoteSessionId"];
  NSMutableDictionary* localBootstrap=[local mutableCopy]; localBootstrap[@"target"]=bootstrap[@"target"];
  SessionBinding localBinding; assert(parse_session_binding(localBootstrap,localBinding,error));
  NSDictionary* localCapture=session_association_dictionary(localBinding);
  assert([key(localCapture) isEqual:key(local)]);
  generation=owner.grant(key(local).UTF8String,"window",now); assert(generation && held);
  assert(owner.begin_borrow(key(localCapture).UTF8String,now,borrowed));
  owner.stop();
  assert(owner.finish_borrow(borrowed,true,now));
  localBootstrap[@"workspaceIdentity"]=@"other";
  assert(!parse_session_binding(localBootstrap,localBinding,error));
  localBootstrap[@"workspaceIdentity"]=@"identity"; localBootstrap[@"remoteSessionId"]=@"";
  assert(!parse_session_binding(localBootstrap,localBinding,error));
} }
