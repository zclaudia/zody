#import <AppKit/AppKit.h>
#import <unistd.h>
#import "contract.h"
#import "explicit_manifest.h"
#import "write_barrier.h"

// 业务模型只由 AppKit 主队列写入；磁盘快照是异步投影，AX 回显不是验收事实。
@interface WriteModel : NSObject
@property(nonatomic) NSUInteger presses;
@property(nonatomic) NSUInteger requests;
@property(nonatomic, copy) NSString *value;
@property(nonatomic) BOOL ignoreEffects;
@property(nonatomic, strong) id<WriteBarrierGate> barrier;
@property(nonatomic, copy) void (^changed)(void);
- (void)press:(id)sender;
- (BOOL)assign:(NSString *)value;
- (NSDictionary *)snapshot;
@end
@implementation WriteModel
- (instancetype)init { if ((self = [super init])) _value = @"E2E_R2_INITIAL"; return self; }
- (void)press:(id)sender {
  if (![NSThread isMainThread]) { dispatch_sync(dispatch_get_main_queue(), ^{ [self press:sender]; }); return; }
  (void)sender; self.requests += 1;
  BOOL released = !self.barrier || [self.barrier waitForRelease];
  if (released && !self.ignoreEffects) self.presses += 1;
  if (self.changed) self.changed();
}
- (BOOL)assign:(NSString *)value {
  if (![NSThread isMainThread]) {
    __block BOOL result=NO;
    dispatch_sync(dispatch_get_main_queue(), ^{ result=[self assign:value]; });
    return result;
  }
  self.requests += 1;
  BOOL released = !self.barrier || [self.barrier waitForRelease];
  BOOL committed = released && !self.ignoreEffects;
  if (committed) self.value = value;
  if (self.changed) self.changed();
  return committed;
}
- (NSDictionary *)snapshot {
  return @{ @"presses": @(self.presses), @"requests": @(self.requests), @"value": self.value,
    @"ignoreEffects": @(self.ignoreEffects) };
}
@end

@interface WriteField : NSTextField
@property(nonatomic, strong) WriteModel *model;
@end
@implementation WriteField
- (void)setAccessibilityValue:(id)value {
  if (![value isKindOfClass:NSString.class]) return;
  if (![NSThread isMainThread]) {
    dispatch_sync(dispatch_get_main_queue(), ^{ [self setAccessibilityValue:value]; });
    return;
  }
  if ([self.model assign:value]) [super setAccessibilityValue:value];
}
@end

@interface WriteFixture : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSWindow *target;
@property(nonatomic, strong) NSWindow *sibling;
@property(nonatomic, strong) WriteModel *targetModel;
@property(nonatomic, strong) WriteModel *siblingModel;
@property(nonatomic, strong) ExplicitManifestWriter *writer;
@property(nonatomic, copy) NSString *directory;
@property(nonatomic) BOOL ignoreEffects;
@property(nonatomic) BOOL barrierEnabled;
@property(nonatomic, strong) WriteBarrier *barrier;
- (void)save;
@end
@implementation WriteFixture
- (NSWindow *)windowAt:(NSRect)frame model:(WriteModel *)model marker:(NSString *)marker {
  NSWindow *window = [[NSWindow alloc] initWithContentRect:frame
    styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
  window.title = @"Zody R2 Controlled Fixture";
  window.releasedWhenClosed = NO;
  window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
  NSButton *button = [NSButton buttonWithTitle:@"R2 Press" target:model action:@selector(press:)];
  button.frame = NSMakeRect(20, 80, 150, 32);
  [button setAccessibilityLabel:@"E2E_R2_PRESS"];
  [window.contentView addSubview:button];
  WriteField *field = [[WriteField alloc] initWithFrame:NSMakeRect(20, 35, 260, 28)];
  field.model = model; field.stringValue = model.value; field.editable = YES;
  [field setAccessibilityLabel:@"E2E_R2_VALUE"];
  [window.contentView addSubview:field];
  NSTextField *label = [NSTextField labelWithString:marker];
  label.frame = NSMakeRect(20, 120, 260, 24);
  [window.contentView addSubview:label];
  [window orderFrontRegardless];
  return window;
}
- (void)save {
  NSInteger a = self.target.windowNumber, b = self.sibling.windowNumber;
  if (a <= 0 || b <= 0 || a == b) exit(1);
  NSMutableDictionary *snapshot = [@{ @"fixtureKind": @"controlled-ax-write-v1", @"pid": @(getpid()),
    @"targetWindow": @(a), @"siblingWindow": @(b), @"title": @"Zody R2 Controlled Fixture",
    @"targetMarker": @"E2E_R2_TARGET_BODY", @"siblingMarker": @"E2E_R2_SIBLING_BODY",
    @"target": self.targetModel.snapshot, @"sibling": self.siblingModel.snapshot } mutableCopy];
  snapshot[@"barrierEnabled"] = @(self.barrierEnabled);
  if (self.barrierEnabled) snapshot[@"barrierNonce"] = self.barrier.nonce;
  NSData *data = [NSJSONSerialization dataWithJSONObject:snapshot options:NSJSONWritingSortedKeys error:nil];
  if (!data) exit(1);
  [self.writer writeData:data path:[self.directory stringByAppendingPathComponent:@"manifest.json"] completion:^(BOOL ok) {
    if (!ok) exit(1);
  }];
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  self.targetModel = [WriteModel new]; self.siblingModel = [WriteModel new];
  self.targetModel.ignoreEffects = self.ignoreEffects;
  if (self.barrierEnabled) {
    self.barrier = [[WriteBarrier alloc] initWithDirectory:self.directory timeoutMilliseconds:700];
    if (!self.barrier) exit(1);
    self.targetModel.barrier = self.barrier;
  }
  self.target = [self windowAt:NSMakeRect(80, 350, 310, 170) model:self.targetModel marker:@"E2E_R2_TARGET_BODY"];
  self.sibling = [self windowAt:NSMakeRect(410, 350, 310, 170) model:self.siblingModel marker:@"E2E_R2_SIBLING_BODY"];
  __weak WriteFixture *weakSelf = self;
  self.targetModel.changed = ^{ [weakSelf save]; };
  self.siblingModel.changed = ^{ [weakSelf save]; };
  [self save];
}
@end

#ifdef WRITE_FIXTURE_TEST
#include <cassert>
#include <atomic>
#include <thread>
#include <chrono>
@interface FakeWriteBarrier : NSObject
@property(nonatomic) BOOL allowed;
- (BOOL)waitForRelease;
@end
@implementation FakeWriteBarrier
- (BOOL)waitForRelease { return self.allowed; }
@end
int main(int argc, const char *argv[]) { @autoreleasepool {
  assert(argc==2);
  WriteModel *model = [WriteModel new];
  [model press:nil]; [model assign:@"E2E_R2_CHANGED"];
  assert(model.presses == 1 && model.requests == 2 && [model.value isEqual:@"E2E_R2_CHANGED"]);
  model.ignoreEffects = YES; [model press:nil]; [model assign:@"E2E_R2_IGNORED"];
  assert(model.presses == 1 && model.requests == 4 && [model.value isEqual:@"E2E_R2_CHANGED"]);
  model.ignoreEffects = NO;
  FakeWriteBarrier *barrier=[FakeWriteBarrier new]; model.barrier=(id)barrier;
  [model press:nil]; [model assign:@"NOT_COMMITTED"];
  assert(model.presses==1 && model.requests==6 && [model.value isEqual:@"E2E_R2_CHANGED"]);
  barrier.allowed=YES; [model press:nil]; [model assign:@"COMMITTED"];
  assert(model.presses==2 && model.requests==8 && [model.value isEqual:@"COMMITTED"]);
  model.ignoreEffects=YES; [model press:nil]; [model assign:@"IGNORED"];
  assert(model.presses==2 && model.requests==10 && [model.value isEqual:@"COMMITTED"]);
  // 使用真实文件屏障，发布 pending 后、release 前业务提交回调必须仍未发生。
  NSString *directory=[NSString stringWithUTF8String:argv[1]];
  WriteBarrier *real=[[WriteBarrier alloc] initWithDirectory:directory timeoutMilliseconds:700];
  model.ignoreEffects=NO; model.barrier=real;
  auto changed=std::make_shared<std::atomic<bool>>(false);
  model.changed=^{ changed->store(true,std::memory_order_release); };
  NSString *pending=[directory stringByAppendingPathComponent:@"write-pending.json"];
  NSString *release=[directory stringByAppendingPathComponent:@"write-release.json"];
  std::thread controller([=] { @autoreleasepool {
    for (int i=0;i<100;++i) {
      NSData *data=[NSData dataWithContentsOfFile:pending];
      id item=data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
      if ([item isKindOfClass:NSDictionary.class] && [item[@"nonce"] isEqual:real.nonce] && [item[@"sequence"] isEqual:@1]) {
        assert(!changed->load(std::memory_order_acquire));
        NSData *releaseData=[NSJSONSerialization dataWithJSONObject:item options:0 error:nil];
        assert([releaseData writeToFile:release options:NSDataWritingAtomic error:nil]);
        return;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
  } });
  [model press:nil]; controller.join();
  assert(changed->load(std::memory_order_acquire) && model.presses==3 && model.requests==11);
} }
#else
int main(int argc, const char *argv[]) { @autoreleasepool {
  if (argc < 2 || argc > 4 || !ValidRunDirectory([NSString stringWithUTF8String:argv[1]])) return 2;
  BOOL ignore=NO, enabled=NO;
  for (int i=2;i<argc;++i) {
    if (strcmp(argv[i], "--ignore-effects")==0 && !ignore) ignore=YES;
    else if (strcmp(argv[i], "--barrier")==0 && !enabled) enabled=YES;
    else return 2;
  }
  WriteFixture *fixture = [WriteFixture new]; fixture.writer = [ExplicitManifestWriter new];
  fixture.directory = [NSString stringWithUTF8String:argv[1]]; fixture.ignoreEffects = ignore;
  fixture.barrierEnabled = enabled;
  [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  [NSApp setDelegate:fixture]; [NSApp run];
} return 0; }
#endif
