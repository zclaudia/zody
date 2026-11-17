#import "write_barrier.h"
#include <atomic>
#include <chrono>
#include <memory>
#include <thread>
@interface WriteBarrier ()
@property(nonatomic, readwrite, copy) NSString *nonce;
@property(nonatomic, copy) NSString *directory;
@property(nonatomic) NSUInteger timeoutMilliseconds;
@property(nonatomic) NSUInteger sequence;
@property(nonatomic) dispatch_queue_t ioQueue;
@end
@implementation WriteBarrier
- (instancetype)initWithDirectory:(NSString *)directory timeoutMilliseconds:(NSUInteger)milliseconds {
  if (!directory.length || milliseconds==0 || milliseconds>700) return nil;
  if ((self=[super init])) {
    _directory=[directory copy]; _timeoutMilliseconds=milliseconds;
    _nonce=[NSUUID UUID].UUIDString;
    _ioQueue=dispatch_queue_create("org.zody.write-fixture.barrier", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}
- (BOOL)waitForRelease {
  __block NSUInteger sequence;
  @synchronized (self) { if (_sequence==NSUIntegerMax) return NO; sequence=++_sequence; }
  NSString *nonce=self.nonce, *directory=self.directory;
  const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(self.timeoutMilliseconds);
  auto matched=std::make_shared<std::atomic<bool>>(false);
  dispatch_semaphore_t done=dispatch_semaphore_create(0);
  dispatch_async(self.ioQueue, ^{ @autoreleasepool {
    NSString* pending=[directory stringByAppendingPathComponent:@"write-pending.json"];
    NSString* release=[directory stringByAppendingPathComponent:@"write-release.json"];
    NSDictionary* request=@{ @"nonce":nonce, @"sequence":@(sequence) };
    NSData* encoded=[NSJSONSerialization dataWithJSONObject:request options:NSJSONWritingSortedKeys error:nil];
    if (encoded && std::chrono::steady_clock::now()<deadline &&
        [encoded writeToFile:pending options:NSDataWritingAtomic error:nil]) {
      while (std::chrono::steady_clock::now()<deadline) {
        NSFileHandle* file=[NSFileHandle fileHandleForReadingAtPath:release];
        NSData* data=[file readDataOfLength:4097];
        [file closeFile];
        id value=(data && data.length<=4096) ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        id number=[value isKindOfClass:NSDictionary.class] ? value[@"sequence"] : nil;
        const bool integer=[number isKindOfClass:NSNumber.class] &&
          CFGetTypeID((__bridge CFTypeRef)number)==CFNumberGetTypeID() &&
          !CFNumberIsFloatType((__bridge CFNumberRef)number);
        if ([value isKindOfClass:NSDictionary.class] && [value count]==2 && integer &&
            [value[@"nonce"] isEqual:nonce] && [number isEqual:@(sequence)]) {
          matched->store(true,std::memory_order_release); break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
    }
    dispatch_semaphore_signal(done);
  } });
  const int64_t nanos=static_cast<int64_t>(self.timeoutMilliseconds)*NSEC_PER_MSEC;
  return dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,nanos))==0 &&
    matched->load(std::memory_order_acquire);
}
@end
