#import <AppKit/AppKit.h>
#import <signal.h>
#import <unistd.h>
#import "contract.h"
#import "explicit_surface.h"
#import "explicit_manifest.h"

@interface ExplicitFixture : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property(nonatomic, strong) NSWindow *target;
@property(nonatomic, strong) NSWindow *sibling;
@property(nonatomic, copy) NSString *directory;
@property(nonatomic) BOOL rebuilding;
@property(nonatomic, strong) dispatch_source_t signalSource;
@property(nonatomic, strong) ExplicitManifestWriter *manifestWriter;
@end
@implementation ExplicitFixture
- (NSWindow *)windowAt:(NSRect)frame marker:(NSString *)marker {
  ExplicitWindow *window = ExplicitMakeWindow(frame, marker);
  window.delegate = self;
  // 原因：验收候选切换 Space 会使夹具离屏；只配置夹具可见性，不激活或切换 Space。
  window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
  [window orderFrontRegardless];
  return window;
}
- (void)writeManifest {
  // NSWindow.windowNumber 是窗口服务器 ID，须在窗口显示后读取并验证唯一。
  NSInteger a = self.target.windowNumber, b = self.sibling.windowNumber;
  if (a <= 0 || b <= 0 || a == b) { fprintf(stderr, "invalid window IDs\n"); exit(1); }
  NSDictionary *manifest = @{@"fixtureKind": @"explicit-ax-content-v1", @"pid": @(getpid()), @"targetWindow": @(a), @"siblingWindow": @(b),
    @"targetMarker": TargetMarker(), @"siblingMarker": SiblingMarker(),
    @"title": @"Zody R1 Observation Fixture"};
  NSData *data = [NSJSONSerialization dataWithJSONObject:manifest options:NSJSONWritingSortedKeys error:nil];
  if (!data) { fprintf(stderr, "manifest serialization failed\n"); exit(1); }
  // 窗口与快照由主队列持有；串行 IO 保证后续重建快照不会被旧写入覆盖。
  [self.manifestWriter writeData:data path:[self.directory stringByAppendingPathComponent:@"manifest.json"] completion:^(BOOL ok) {
    if (!ok) { fprintf(stderr, "manifest write failed\n"); exit(1); }
  }];
  }
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  self.target = [self windowAt:NSMakeRect(80, 350, 300, 130) marker:TargetMarker()];
  self.sibling = [self windowAt:NSMakeRect(410, 350, 300, 130) marker:SiblingMarker()];
  [self writeManifest];
  // 信号仅控制夹具自身窗口，供失效和重建场景使用，不调用 AX 操作。
  signal(SIGUSR1, SIG_IGN);
  self.signalSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGUSR1, 0, dispatch_get_main_queue());
  dispatch_source_set_event_handler(self.signalSource, ^{
    self.rebuilding = YES;
    [self.target close];
    self.target = [self windowAt:NSMakeRect(80, 350, 300, 130) marker:TargetMarker()];
    self.rebuilding = NO;
    [self writeManifest];
  });
  dispatch_resume(self.signalSource);
  // Launch Services 的父进程不代表调用方生命周期；测试结束向 manifest 的 PID 发送 SIGTERM。
}
- (void)windowWillClose:(NSNotification *)notification { (void)notification; if (!self.rebuilding) [NSApp terminate:nil]; }
@end
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2 || !ValidRunDirectory([NSString stringWithUTF8String:argv[1]])) {
      fprintf(stderr, "expected one existing normalized absolute run directory\n"); return 2;
    }
    ExplicitFixture *fixture = [ExplicitFixture new]; fixture.manifestWriter = [ExplicitManifestWriter new]; fixture.directory = [NSString stringWithUTF8String:argv[1]];
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp setDelegate:fixture]; [NSApp run];
  }
  return 0;
}
