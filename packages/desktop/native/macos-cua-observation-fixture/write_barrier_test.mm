#import <Foundation/Foundation.h>
#import "write_barrier.h"
#include <cassert>
#include <atomic>
static NSDictionary* read_json(NSString* path) {
  NSData* data=[NSData dataWithContentsOfFile:path];
  return data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
}
static void put(NSString* path, NSDictionary* value) {
  NSData* data=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  assert([data writeToFile:path options:NSDataWritingAtomic error:nil]);
}
static NSDictionary* await_pending(NSString* path, NSUInteger sequence) {
  for (int i=0;i<100;++i) {
    NSDictionary* p=read_json(path);
    if ([p[@"sequence"] unsignedIntegerValue]==sequence) return p;
    [NSThread sleepForTimeInterval:0.005];
  }
  return nil;
}
int main(int argc,const char* argv[]) { @autoreleasepool {
  assert(argc==2); NSString* dir=[NSString stringWithUTF8String:argv[1]];
  NSString* pending=[dir stringByAppendingPathComponent:@"write-pending.json"];
  NSString* release=[dir stringByAppendingPathComponent:@"write-release.json"];
  [[NSFileManager defaultManager] removeItemAtPath:pending error:nil];
  [[NSFileManager defaultManager] removeItemAtPath:release error:nil];
  WriteBarrier* b=[[WriteBarrier alloc] initWithDirectory:dir timeoutMilliseconds:250];
  assert(b && b.nonce.length>0);
  dispatch_semaphore_t done=dispatch_semaphore_create(0); __block BOOL result=NO;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT,0), ^{ result=[b waitForRelease]; dispatch_semaphore_signal(done); });
  NSDictionary* p=await_pending(pending,1); assert(p && [p[@"nonce"] isEqual:b.nonce]);
  put(release,@{ @"nonce":@"wrong", @"sequence":@1 });
  assert(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,40*NSEC_PER_MSEC))!=0);
  put(release,@{ @"nonce":b.nonce, @"sequence":@YES });
  assert(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,40*NSEC_PER_MSEC))!=0);
  put(release,p); assert(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,500*NSEC_PER_MSEC))==0 && result);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT,0), ^{ result=[b waitForRelease]; dispatch_semaphore_signal(done); });
  p=await_pending(pending,2); assert(p);
  assert(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,40*NSEC_PER_MSEC))!=0); // old release cannot repeat
  put(release,@{ @"nonce":b.nonce, @"sequence":@1 });
  assert(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,40*NSEC_PER_MSEC))!=0);
  put(release,p); assert(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,500*NSEC_PER_MSEC))==0 && result);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT,0), ^{ result=[b waitForRelease]; dispatch_semaphore_signal(done); });
  assert(await_pending(pending,3));
  assert(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,600*NSEC_PER_MSEC))==0 && !result);
} }
