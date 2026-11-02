#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

#include <unistd.h>

// 固定产物路径：controller 通过 LaunchServices 启动后读取该文件。
static NSString* const kResultPath =
    @"/Users/zhvala/SourceCode/zody/output/cua-launchservices/preflight-probe/result.json";

@interface ProbeDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSWindow* window;
@property(nonatomic, copy) NSString* statusText;
- (instancetype)initWithStatusText:(NSString*)statusText;
@end

@implementation ProbeDelegate

- (instancetype)initWithStatusText:(NSString*)statusText {
  self = [super init];
  if (self) _statusText = [statusText copy];
  return self;
}

- (void)applicationDidFinishLaunching:(NSNotification*)notification {
  (void)notification;
  const NSRect frame = NSMakeRect(0, 0, 560, 190);
  self.window = [[NSWindow alloc]
      initWithContentRect:frame
                styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable)
                  backing:NSBackingStoreBuffered
                    defer:NO];
  self.window.title = @"Zody CUA Preflight Probe";
  self.window.releasedWhenClosed = NO;

  NSTextField* label = [[NSTextField alloc] initWithFrame:NSMakeRect(16, 16, 528, 158)];
  label.editable = NO;
  label.selectable = YES;
  label.bezeled = NO;
  label.drawsBackground = NO;
  label.font = [NSFont monospacedSystemFontOfSize:12 weight:NSFontWeightRegular];
  label.stringValue = self.statusText;
  label.usesSingleLineMode = NO;
  label.maximumNumberOfLines = 0;
  label.cell.wraps = YES;
  label.cell.lineBreakMode = NSLineBreakByWordWrapping;
  label.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [self.window.contentView addSubview:label];

  [self.window center];
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication*)sender {
  (void)sender;
  return YES;
}

@end

int main(int argc, const char* argv[]) {
  (void)argc;
  (void)argv;
  @autoreleasepool {
    [NSApplication sharedApplication];

    // 只查询一次 preflight；绝不调用 CGRequest/ScreenCaptureKit。
    const BOOL preflight = CGPreflightScreenCaptureAccess();
    NSString* bundleId = [[NSBundle mainBundle] bundleIdentifier];
    if (bundleId == nil) bundleId = @"<missing>";

    NSISO8601DateFormatter* formatter = [[NSISO8601DateFormatter alloc] init];
    formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
    formatter.formatOptions =
        NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
    NSString* utc = [formatter stringFromDate:[NSDate date]];

    NSDictionary* result = @{
      @"pid" : @(getpid()),
      @"ppid" : @(getppid()),
      @"bundleId" : bundleId,
      @"preflight" : preflight ? @YES : @NO,
      @"utc" : utc,
    };
    NSError* writeError = nil;
    NSData* json = [NSJSONSerialization
        dataWithJSONObject:result
                   options:(NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys)
                     error:&writeError];
    const BOOL wrote =
        json != nil && [json writeToFile:kResultPath options:NSDataWritingAtomic error:&writeError];

    NSMutableString* status = [NSMutableString stringWithFormat:
        @"pid: %d\nppid: %d\nbundle: %@\npreflight: %@\nUTC: %@\nresult: %@",
        getpid(), getppid(), bundleId, preflight ? @"true" : @"false", utc, kResultPath];
    if (!wrote) {
      [status appendFormat:@"\nwrite error: %@", writeError.localizedDescription ?: @"unknown"];
    }

    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    ProbeDelegate* delegate = [[ProbeDelegate alloc] initWithStatusText:status];
    NSApp.delegate = delegate;
    [NSApp run];
  }
  return 0;
}
