#import <AppKit/AppKit.h>
#import <signal.h>
#import <unistd.h>
#import "contract.h"

@interface Fixture : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property(nonatomic, strong) NSWindow *target;
@property(nonatomic, strong) NSWindow *sibling;
@property(nonatomic, copy) NSString *directory;
@property(nonatomic) BOOL rebuilding;
@property(nonatomic, strong) dispatch_source_t signalSource;
@end
@implementation Fixture
- (NSWindow *)windowAt:(NSRect)frame marker:(NSString *)marker {
  NSWindow *window = [[NSWindow alloc] initWithContentRect:frame
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
      backing:NSBackingStoreBuffered defer:NO];
  window.title = @"Zody R1 Observation Fixture";
  window.releasedWhenClosed = NO;
  window.delegate = self;
  NSTextField *field = [[NSTextField alloc] initWithFrame:NSMakeRect(20, 35, 260, 28)];
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
    @"title": @"Zody R1 Observation Fixture"};
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
    Fixture *fixture = [Fixture new]; fixture.directory = [NSString stringWithUTF8String:argv[1]];
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp setDelegate:fixture]; [NSApp run];
  }
  return 0;
}
