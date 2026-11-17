#include "observer_source.h"
#include "observer_state.h"
#include "observer_system_view.h"
#include <cassert>
#include <cstdio>
using namespace zody::cua::desktop_session;
namespace {
AXUIElementRef root, local, remote, secret, sibling;
int remote_content=0, remote_actions=0, sibling_content=0;
bool include_remote=true, include_sibling=false;
int fault=0;
AXError Pid(AXUIElementRef, pid_t* p){*p=777;return kAXErrorSuccess;}
AXError Actual(AXUIElementRef n,pid_t* p){if(fault==1&&n==remote)return kAXErrorCannotComplete;*p=(n==remote||n==secret||(fault==2&&n==root)||(fault==3&&n==local))?888:777;return kAXErrorSuccess;}
AXError Window(AXUIElementRef n,uint32_t* w){if(fault==4&&n==remote)return kAXErrorCannotComplete;*w=(fault==5&&n==remote)?0:(n==remote||n==secret)?99:n==sibling?41:40;return kAXErrorSuccess;}
AXError Timeout(AXUIElementRef,float){return kAXErrorSuccess;}
AXError Attribute(AXUIElementRef n,CFStringRef key,CFTypeRef* out){
  *out=nullptr;
  const bool content=CFEqual(key,kAXTitleAttribute)||CFEqual(key,kAXValueAttribute)||CFEqual(key,kAXChildrenAttribute);
  if(n==remote||n==secret){if(content)++remote_content;assert(!content&&"remote content getter must never run");}
  if(n==sibling){if(content)++sibling_content;assert(!content&&"sibling content getter must never run");}
  id value=nil;
  if(CFEqual(key,kAXWindowAttribute)){*out=root;CFRetain(root);return kAXErrorSuccess;}
  if(CFEqual(key,kAXRoleAttribute))value=n==root?(__bridge id)kAXWindowRole:(__bridge id)kAXStaticTextRole;
  else if(CFEqual(key,kAXTitleAttribute)||CFEqual(key,kAXValueAttribute))value=n==remote||n==secret?@"E2E_REMOTE_SECRET":n==sibling?@"E2E_SIBLING_SECRET":n==local?@"E2E_LOCAL_TARGET":@"";
  else if(CFEqual(key,kAXChildrenAttribute)){
    NSMutableArray* children=[NSMutableArray array];
    if(n==root){[children addObject:(__bridge id)local];if(include_remote)[children addObject:(__bridge id)remote];if(include_sibling)[children addObject:(__bridge id)sibling];}
    if(n==remote)[children addObject:(__bridge id)secret];
    value=children;
  }
  if(!value)return kAXErrorNoValue;
  *out=CFBridgingRetain(value);return kAXErrorSuccess;
}
AXError Actions(AXUIElementRef n,CFArrayRef* out){
  if(n==remote||n==secret)++remote_actions;
  assert(n!=remote&&n!=secret&&n!=sibling&&"foreign actions must never run");
  *out=CFArrayCreate(nullptr,nullptr,0,&kCFTypeArrayCallBacks);return kAXErrorSuccess;
}
bool Opaque(AXUIElementRef,pid_t target,uint32_t window,pid_t actual,uint32_t direct,ObserverReadDeadline){
  ObserverSystemViewProof p;p.target_pid=target;p.target_window=window;
  p.actual_before=p.actual_after=actual;p.cg_before=p.cg_after=888;
  p.direct_before=p.direct_after=direct;p.seconds_before=p.seconds_after=10;p.micros_before=p.micros_after=5;
  p.complete=true;p.apple_anchor=fault!=6;p.exact_identifier=fault!=7;p.exact_system_path=fault!=8;
  if(fault==9)++p.seconds_after;if(fault==10)++p.cg_after;
  return observer_system_view_may_omit(p);
}
}
int main(){@autoreleasepool{
  root=AXUIElementCreateApplication(777);local=AXUIElementCreateApplication(778);
  remote=AXUIElementCreateApplication(888);secret=AXUIElementCreateApplication(889);sibling=AXUIElementCreateApplication(779);
  const ObserverAXReader reader={Pid,Window,Actual,Timeout,Attribute,Actions,Opaque};
  auto run=[&](NSMutableArray* elements,NSMutableArray* handles,bool& truncated,std::string& error){return observer_walk_tree(root,777,40,std::chrono::steady_clock::now()+std::chrono::seconds(2),elements,handles,truncated,error,reader);};
  NSMutableArray* elements=[NSMutableArray array];NSMutableArray* handles=[NSMutableArray array];bool truncated=false;std::string error;
  const bool ok=run(elements,handles,truncated,error);
  if(!ok)std::fprintf(stderr,"repro: real walker rejected opaque service: %s\n",error.c_str());
  assert(ok&&"known opaque service must not fail local projection");
  assert(truncated&&elements.count==2&&handles.count==2);
  assert(remote_content==0&&remote_actions==0&&sibling_content==0);
  assert(![handles containsObject:(__bridge id)remote]&&![handles containsObject:(__bridge id)secret]);
  ObserverState state;NSDictionary* window=@{@"pid":@777,@"window_id":@40};
  auto first=state.prepare(@"scope",@{},window,@"identity",elements,handles,truncated,true,false);state.commit(first);
  auto diff=state.prepare(@"scope",@{},window,@"identity",elements,handles,truncated,true,false);
  assert([diff.result[@"structuredContent"][@"snapshot_mode"] isEqual:@"diff"]);
  assert([diff.result[@"structuredContent"][@"truncated"] boolValue]);
  assert([diff.result.description rangeOfString:@"E2E_REMOTE_SECRET"].location==NSNotFound);
  assert([first.result.description rangeOfString:@"E2E_LOCAL_TARGET"].location!=NSNotFound);
  assert([first.result.description rangeOfString:@"E2E_REMOTE_SECRET"].location==NSNotFound);
  assert([first.result.description rangeOfString:@"E2E_SIBLING_SECRET"].location==NSNotFound);
  state.commit(diff);
  auto silent=state.prepare(@"scope",@{},window,@"identity",elements,handles,truncated,false,false);state.commit(silent);
  auto fourth=state.prepare(@"scope",@{},window,@"identity",elements,handles,truncated,true,false);
  assert([fourth.result[@"structuredContent"][@"snapshot_mode"] isEqual:@"full"]);state.commit(fourth);
  auto fifth=state.prepare(@"scope",@{},window,@"identity",elements,handles,truncated,true,false);
  assert([fifth.result[@"structuredContent"][@"snapshot_mode"] isEqual:@"diff"]);
  for(fault=1;fault<=10;++fault){
    [elements removeAllObjects];[handles removeAllObjects];truncated=false;error.clear();
    assert(!run(elements,handles,truncated,error)&&error=="element_unavailable");
    assert(elements.count==0&&handles.count==0&&remote_content==0&&remote_actions==0&&sibling_content==0);
  }
  fault=0;
  include_sibling=true;[elements removeAllObjects];[handles removeAllObjects];truncated=false;
  assert(!run(elements,handles,truncated,error)&&error=="element_unavailable");
  assert(elements.count==0&&handles.count==0&&remote_content==0&&sibling_content==0);
  include_sibling=false;
  for(int missing=0;missing<3;++missing){
    auto unavailable=reader;
    if(missing==0)unavailable.actual_pid=nullptr;
    if(missing==1)unavailable.window=nullptr;
    if(missing==2)unavailable.opaque=nullptr;
    error.clear();truncated=false;
    assert(!observer_walk_tree(root,777,40,std::chrono::steady_clock::now()+std::chrono::seconds(2),elements,handles,truncated,error,unavailable));
    assert(error==(missing==1?"broker_unavailable":"element_unavailable"));
    assert(elements.count==0&&handles.count==0&&remote_content==0&&remote_actions==0&&sibling_content==0);
  }
  error.clear();
  assert(!observer_walk_tree(root,777,40,std::chrono::steady_clock::now()-std::chrono::seconds(1),elements,handles,truncated,error,reader));
  assert(error=="timeout"&&elements.count==0&&handles.count==0&&remote_content==0&&remote_actions==0);
  CFRelease(root);CFRelease(local);CFRelease(remote);CFRelease(secret);CFRelease(sibling);
  std::puts("observer-opaque-view: passed");return 0;
}}
