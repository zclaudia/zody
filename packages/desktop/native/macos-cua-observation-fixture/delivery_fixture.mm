#import <AppKit/AppKit.h>
#import <signal.h>
#import <unistd.h>
#import "contract.h"

#include <chrono>
static NSString *gate_directory;
static volatile sig_atomic_t gate_released = 0;
static bool body_seen = false, gate_entered = false;
static void release_gate(int) { gate_released = 1; }
static void receipt(NSString *name, NSDictionary *fields) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:fields options:NSJSONWritingSortedKeys error:nil];
  if (![data writeToFile:[gate_directory stringByAppendingPathComponent:name] options:NSDataWritingAtomic error:nil]) exit(3);
}
// 中文原因：独立测试夹具只延迟真实 AX 回答，不修改属性值、父链或权限；生产观察器无测试开关。
@interface DeliveryField : NSTextField
@end
@implementation DeliveryField
- (id)accessibilityValue { id value = [super accessibilityValue]; body_seen = true; return value; }
@end
@interface DeliveryWindow : NSWindow
@end
@implementation DeliveryWindow
- (BOOL)isAccessibilityMinimized {
  if (body_seen && !gate_entered) {
    gate_entered = true;
    receipt(@"gate-entered.json", @{ @"pid": @(getpid()), @"event": @"after-body-before-window-recheck", @"sequence": @1 });
    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1800);
    while (!gate_released && std::chrono::steady_clock::now() < deadline) usleep(1000);
    receipt(@"gate-released.json", @{ @"pid": @(getpid()), @"event": gate_released ? @"explicit-release" : @"timeout", @"sequence": @2 });
  }
  return [super isAccessibilityMinimized];
}
@end
@interface Fixture : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property(nonatomic, strong) NSWindow *target;
@property(nonatomic, strong) NSWindow *sibling;
@property(nonatomic, copy) NSString *directory;
@property(nonatomic) BOOL rebuilding;
@property(nonatomic, strong) dispatch_source_t signalSource;
@end
@implementation Fixture
- (NSWindow *)windowAt:(NSRect)frame marker:(NSString *)marker {
  NSWindow *window = [[DeliveryWindow alloc] initWithContentRect:frame
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
      backing:NSBackingStoreBuffered defer:NO];
  window.title = @"Zody R1 Observation Fixture";
  window.releasedWhenClosed = NO;
  window.delegate = self;
  NSTextField *field = [[DeliveryField alloc] initWithFrame:NSMakeRect(20, 35, 260, 28)];
  field.stringValue = marker;
  field.editable = NO;
  [field setAccessibilityLabel:@"R1 Fixture Body"];
  [window.contentView addSubview:field];
  // 原因：验收候选切换 Space 会使夹具离屏；只配置夹具可见性，不激活或切换 Space。
  window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
  [window orderFrontRegardless];
  return window;
}
- (void)writeManifest {
  // NSWindow.windowNumber 是窗口服务器 ID，须在窗口显示后读取并验证唯一。
  NSInteger a = self.target.windowNumber, b = self.sibling.windowNumber;
  if (a <= 0 || b <= 0 || a == b) { fprintf(stderr, "invalid window IDs\n"); exit(1); }
  NSDictionary *manifest = @{@"pid": @(getpid()), @"targetWindow": @(a), @"siblingWindow": @(b),
    @"targetMarker": TargetMarker(), @"siblingMarker": SiblingMarker(),
    @"title": @"Zody R1 Observation Fixture", @"fixtureKind": @"controlled-read-delivery-v1"};
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:manifest options:NSJSONWritingSortedKeys error:&error];
  if (!data || ![data writeToFile:[self.directory stringByAppendingPathComponent:@"manifest.json"]
                         options:NSDataWritingAtomic error:&error]) {
    fprintf(stderr, "manifest write failed: %s\n", error.localizedDescription.UTF8String); exit(1);
  }
  }
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  self.target = [self windowAt:NSMakeRect(80, 350, 300, 130) marker:TargetMarker()];
  self.sibling = [self windowAt:NSMakeRect(410, 350, 300, 130) marker:SiblingMarker()];
  [self writeManifest];
  signal(SIGUSR1, release_gate);
  // Launch Services 的父进程不代表调用方生命周期；测试结束向 manifest 的 PID 发送 SIGTERM。
}
- (void)windowWillClose:(NSNotification *)notification { (void)notification; if (!self.rebuilding) [NSApp terminate:nil]; }
@end
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2 || !ValidRunDirectory([NSString stringWithUTF8String:argv[1]])) {
      fprintf(stderr, "expected one existing normalized absolute run directory\n"); return 2;
    }
    gate_directory = [NSString stringWithUTF8String:argv[1]];
    Fixture *fixture = [Fixture new]; fixture.directory = [NSString stringWithUTF8String:argv[1]];
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp setDelegate:fixture]; [NSApp run];
  }
  return 0;
}
