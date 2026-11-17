#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <IOKit/IOKitLib.h>
#include <dlfcn.h>
#include <time.h>
#include <unistd.h>
#include "contract.h"
#include "read_monitor_input.h"
#include "../macos-cua-desktop-session/src/observer_session_status.h"

static NSString *directory;
static dispatch_queue_t io;
static double Now() { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
static void Write(NSString *name, NSDictionary *value) {
  dispatch_async(io, ^{
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
    if (!data || ![data writeToFile:[directory stringByAppendingPathComponent:name] options:NSDataWritingAtomic error:nil]) exit(3);
  });
}
static id Space() {
  using Connection = int (*)(); using Active = uint64_t (*)(int);
  auto connection = reinterpret_cast<Connection>(dlsym(RTLD_DEFAULT, "CGSMainConnectionID"));
  auto active = reinterpret_cast<Active>(dlsym(RTLD_DEFAULT, "CGSGetActiveSpace"));
  if (!connection || !active) return NSNull.null;
  uint64_t value = active(connection()); return value ? @(value) : NSNull.null;
}
static NSArray *Windows() {
  NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
  if (!windows) return nil;
  NSMutableArray *rows = [NSMutableArray array];
  for (NSDictionary *window in windows) {
    if (!window[(id)kCGWindowNumber] || !window[(id)kCGWindowOwnerPID] || !window[(id)kCGWindowLayer]) return nil;
    // 中文原因：只取无标题的真实窗口身份和层序，不能借前台监测采集其他应用正文。
    [rows addObject:@{ @"id": window[(id)kCGWindowNumber], @"pid": window[(id)kCGWindowOwnerPID], @"layer": window[(id)kCGWindowLayer] }];
  }
  return rows;
}
@interface ReadEditor : NSTextView
@property(copy) void (^note)(NSEvent *);
@property BOOL dropNext;
@end
@implementation ReadEditor
- (void)keyDown:(NSEvent *)event {
  if (self.note) self.note(event);
  if (self.dropNext) { self.dropNext = NO; return; }
  [super keyDown:event];
}
@end
@interface ReadMonitor : NSObject <NSApplicationDelegate, NSWindowDelegate>
@end
@implementation ReadMonitor {
  NSWindow *_window;
  ReadEditor *_editor;
  NSButton *_copyButton;
  NSMutableArray *_samples, *_keys, *_focus;
  NSDictionary *_start;
  NSString *_trial;
  NSUInteger _command, _keySequence, _focusSequence, _sampleSequence;
  NSUInteger _startKey, _startFocus;
  NSString *_startText;
  NSRange _startSelection;
  BOOL _readingCommand;
}
- (NSDictionary *)sample {
  NSPoint mouse = NSEvent.mouseLocation;
  NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
  io_registry_entry_t root = IORegistryGetRootEntry(kIOMainPortDefault);
  id locked = root ? CFBridgingRelease(IORegistryEntryCreateCFProperty(root, CFSTR("IOConsoleLocked"), kCFAllocatorDefault, 0)) : nil;
  if (root) IOObjectRelease(root);
  using namespace zody::cua::desktop_session;
  SessionStatus status = observe_session_status();
  CGDirectDisplayID display = CGMainDisplayID();
  return @{ @"sequence": @(++_sampleSequence), @"monotonic": @(Now()), @"active": @(NSApp.active), @"key": @(_window.keyWindow),
    @"firstResponder": @(_window.firstResponder == _editor), @"pointer": @[@(mouse.x), @(mouse.y)],
    @"clipboard": @(NSPasteboard.generalPasteboard.changeCount), @"space": Space(), @"windows": Windows() ?: (id)NSNull.null,
    @"console": StrictState(session[(__bridge NSString *)kCGSessionOnConsoleKey]), @"login": StrictState(session[(__bridge NSString *)kCGSessionLoginDoneKey]),
    @"rootLocked": StrictState(locked), @"cgLocked": StrictState(session[@"CGSSessionScreenIsLocked"]),
    @"displayExists": @(display != 0), @"displayOnline": @(display && CGDisplayIsOnline(display)), @"displayActive": @(display && CGDisplayIsActive(display)),
    @"displayAsleep": @(!display || CGDisplayIsAsleep(display)), @"guard": status == SessionStatus::Allowed ? @"allowed" : status == SessionStatus::Locked ? @"locked" : @"unknown" };
}
- (void)focus:(NSString *)kind {
  NSDictionary *event = @{ @"sequence": @(++_focusSequence), @"monotonic": @(Now()), @"kind": kind };
  [_focus addObject:event];
  Write(@"last-focus.json", event);
}
- (void)applicationDidResignActive:(NSNotification *)n { (void)n; [self focus:@"resign-active"]; }
- (void)applicationDidBecomeActive:(NSNotification *)n { (void)n; [self focus:@"become-active"]; }
- (void)windowDidResignKey:(NSNotification *)n { (void)n; [self focus:@"resign-key"]; }
- (void)windowDidBecomeKey:(NSNotification *)n { (void)n; [self focus:@"become-key"]; }
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  _samples = [NSMutableArray array]; _keys = [NSMutableArray array]; _focus = [NSMutableArray array];
  _window = [[NSWindow alloc] initWithContentRect:NSMakeRect(80, 60, 670, 230) styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
  _window.title = @"R1 只读无干扰验收 — 手动输入窗口"; _window.delegate = self; _window.releasedWhenClosed = NO;
  NSTextField *label = [NSTextField wrappingLabelWithString:@"开始提示后，在此按住数字 1，或连续键入小写字母/数字。无需输入 26 个字母；窗口关闭后停止。不要粘贴或切换窗口。"];
  label.frame = NSMakeRect(20, 150, 630, 60); [_window.contentView addSubview:label];
  _editor = [[ReadEditor alloc] initWithFrame:NSMakeRect(20, 20, 630, 120)]; _editor.richText = NO;
  _editor.automaticSpellingCorrectionEnabled = NO; _editor.automaticTextReplacementEnabled = NO;
  _editor.font = [NSFont monospacedSystemFontOfSize:18 weight:NSFontWeightRegular]; [_window.contentView addSubview:_editor];
  _copyButton = [NSButton buttonWithTitle:@"复制测试数字" target:_editor action:@selector(copy:)];
  _copyButton.frame = NSMakeRect(480, 180, 160, 30); _copyButton.hidden = YES; [_window.contentView addSubview:_copyButton];
  __weak ReadMonitor *weak = self;
  _editor.note = ^(NSEvent *event) {
    ReadMonitor *self = weak; if (!self) return;
    CGEventRef cg = event.CGEvent;
    NSDictionary *key = @{ @"sequence": @(++self->_keySequence), @"monotonic": @(Now()), @"text": event.characters ?: @"",
      @"repeat": @(event.ARepeat), @"sourcePID": cg ? @(CGEventGetIntegerValueField(cg, kCGEventSourceUnixProcessID)) : (id)NSNull.null,
      @"fixtureDropped": @(self->_editor.dropNext),
      @"sourceState": cg ? @(CGEventGetIntegerValueField(cg, kCGEventSourceStateID)) : (id)NSNull.null };
    [self->_keys addObject:key]; Write(@"last-key.json", @{ @"trialId": self->_trial ?: (id)NSNull.null, @"key": key });
  };
  [_window makeKeyAndOrderFront:nil]; [NSApp activate]; [_window makeFirstResponder:_editor];
  Write(@"monitor-ready.json", @{ @"pid": @(getpid()), @"windowId": @(_window.windowNumber), @"executable": NSBundle.mainBundle.executablePath });
  [NSTimer scheduledTimerWithTimeInterval:0.02 repeats:YES block:^(NSTimer *timer) { (void)timer; [weak tick]; }];
}
- (void)apply:(NSDictionary *)command {
  NSNumber *sequence = command[@"sequence"];
  if (![sequence isKindOfClass:NSNumber.class] || sequence.unsignedIntegerValue <= _command) return;
  _command = sequence.unsignedIntegerValue;
  NSString *kind = command[@"kind"], *trial = command[@"trialId"];
  if ([kind isEqual:@"begin"] && !_trial && [trial isKindOfClass:NSString.class] && trial.length && [trial rangeOfString:@"/"].location == NSNotFound) {
    _trial = trial; [_samples removeAllObjects]; _start = [self sample];
    _startKey = _keys.count; _startFocus = _focus.count;
    _startText = [_editor.string copy]; _startSelection = _editor.selectedRange;
    Write(@"monitor-ack.json", @{ @"sequence": sequence, @"trialId": trial, @"sample": _start });
  } else if ([kind isEqual:@"fence"] && [_trial isEqual:trial]) {
    // 中文原因：last-key 异步落盘可能晚于 pending；主线程 ACK 才能建立新的真实键入基线。
    Write(@"key-fence.json", @{ @"sequence": sequence, @"trialId": trial, @"keySequence": @(_keySequence) });
  } else if ([kind isEqual:@"end"] && [_trial isEqual:trial]) {
    NSDictionary *end = [self sample];
    NSString *text = MonitorInsertedText(_startText, _startSelection, _editor.string);
    Write([trial stringByAppendingString:@".json"], @{ @"trialId": trial, @"pid": @(getpid()), @"start": _start, @"end": end, @"samples": [_samples copy],
      @"keys": [_keys subarrayWithRange:NSMakeRange(_startKey, _keys.count - _startKey)], @"focus": [_focus subarrayWithRange:NSMakeRange(_startFocus, _focus.count - _startFocus)], @"insertedText": text ?: (id)NSNull.null });
    _trial = nil; _start = nil; _startText = nil;
  } else if ([kind isEqual:@"prepare-copy"]) {
    // 中文原因：剪贴板校准只让用户复制固定夹具数字，不读取或保存用户原有剪贴板正文。
    _editor.string = @"1111"; [_editor setSelectedRange:NSMakeRange(0, 4)]; _copyButton.hidden = NO;
    [_window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES]; [_window makeFirstResponder:_editor];
    Write(@"copy-ready.json", @{ @"sequence": sequence, @"clipboard": @(NSPasteboard.generalPasteboard.changeCount) });
  } else if ([kind isEqual:@"drop-next-key"]) {
    _editor.dropNext = YES;
    Write(@"injection-armed.json", @{ @"sequence": sequence, @"kind": kind });
  } else if ([kind isEqual:@"calibrate-popup"]) {
    // 中文原因：真实短暂弹窗必须被 key/focus/层序采集检出，不能用修改监测 JSON 代替校准。
    NSPanel *panel = [[NSPanel alloc] initWithContentRect:NSMakeRect(150, 150, 240, 100) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    panel.releasedWhenClosed = NO; panel.title = @"R1 监测校准弹窗";
    [panel makeKeyAndOrderFront:nil];
    Write(@"injection-popup.json", @{ @"sequence": sequence, @"windowId": @(panel.windowNumber) });
    [NSTimer scheduledTimerWithTimeInterval:0.3 repeats:NO block:^(NSTimer *timer) {
      (void)timer; [panel close]; [_window makeKeyAndOrderFront:nil]; [_window makeFirstResponder:_editor];
    }];
  } else if ([kind isEqual:@"calibrate-pointer"]) {
    CGEventRef position = CGEventCreate(nullptr);
    if (!position) return;
    CGPoint before = CGEventGetLocation(position); CFRelease(position);
    CGError error = CGWarpMouseCursorPosition(CGPointMake(before.x + 8, before.y));
    Write(@"injection-pointer.json", @{ @"sequence": sequence, @"cgError": @(error), @"restore": @[@(before.x), @(before.y)] });
    [NSTimer scheduledTimerWithTimeInterval:0.3 repeats:NO block:^(NSTimer *timer) {
      (void)timer; CGWarpMouseCursorPosition(before);
    }];
  }
  else if ([kind isEqual:@"finish"]) {
    Write(@"monitor-complete.json", @{ @"pid": @(getpid()), @"keys": [_keys copy], @"focus": [_focus copy], @"lastSample": [self sample] });
  }
}
- (void)tick {
  if (_trial) [_samples addObject:[self sample]];
  if (_readingCommand) return;
  _readingCommand = YES;
  __weak ReadMonitor *weak = self;
  dispatch_async(io, ^{
    NSData *data = [NSData dataWithContentsOfFile:[directory stringByAppendingPathComponent:@"command.json"]];
    NSDictionary *command = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    dispatch_async(dispatch_get_main_queue(), ^{ ReadMonitor *self = weak; if (!self) return; self->_readingCommand = NO; if ([command isKindOfClass:NSDictionary.class]) [self apply:command]; });
  });
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)app { (void)app; return YES; }
@end
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2 || !ValidRunDirectory([NSString stringWithUTF8String:argv[1]])) return 2;
    directory = [NSString stringWithUTF8String:argv[1]]; io = dispatch_queue_create("org.zody.cua.read-monitor.io", DISPATCH_QUEUE_SERIAL);
    ReadMonitor *monitor = [ReadMonitor new]; [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [NSApp setDelegate:monitor]; [NSApp run];
  }
  return 0;
}
