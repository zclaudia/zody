#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import "ax_driver.h"
#import "verdict.h"

static NSString *const Sample = @"abcdefghijklmnopqrstuvwxyz";
static double Now() { return NSProcessInfo.processInfo.systemUptime; }

static NSURL *ProbeRoot() {
  NSURL *support = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory
                                                        inDomains:NSUserDomainMask]
                       .firstObject;
  return [support URLByAppendingPathComponent:@"Zody AX Probe" isDirectory:YES];
}
static NSDictionary *ReadSnapshot(NSURL *folder) {
  NSData *data = [NSData dataWithContentsOfURL:[folder URLByAppendingPathComponent:@"target.json"]];
  if (!data || data.length > 8192) return nil;
  id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [json isKindOfClass:NSDictionary.class] ? json : nil;
}
static BOOL WriteJSON(NSURL *path, NSDictionary *record, NSError **error) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:record
                                                 options:NSJSONWritingPrettyPrinted
                                                   error:error];
  return data && [data writeToURL:path options:NSDataWritingAtomic error:error];
}

@interface ProbeEditor : NSTextView
@property(copy) void (^noteKey)(NSEvent *);
@end
@implementation ProbeEditor
- (void)keyDown:(NSEvent *)event {
  if (self.noteKey) self.noteKey(event);
  [super keyDown:event];
}
- (void)paste:(id)sender {
  (void)sender;
  NSBeep();
}
@end

// 第二个 AX 动作等待按钮派发后的下一个前台键。停止与按键走同一把锁，旧轮次不能被新按键复活。
@interface InputGate : NSObject
- (void)key;
- (void)stop;
- (BOOL)active;
- (BOOL)waitForKey;
@end
@implementation InputGate {
  NSCondition *_condition;
  NSUInteger _count;
  BOOL _stopped;
}
- (instancetype)init {
  if ((self = [super init])) _condition = [NSCondition new];
  return self;
}
- (void)key {
  [_condition lock];
  _count++;
  [_condition broadcast];
  [_condition unlock];
}
- (void)stop {
  [_condition lock];
  _stopped = YES;
  [_condition broadcast];
  [_condition unlock];
}
- (BOOL)active {
  [_condition lock];
  BOOL active = !_stopped;
  [_condition unlock];
  return active;
}
- (BOOL)waitForKey {
  [_condition lock];
  NSUInteger previous = _count;
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:15];
  while (!_stopped && previous == _count && [_condition waitUntilDate:deadline]) {
  }
  BOOL received = !_stopped && _count > previous;
  [_condition unlock];
  return received;
}
@end

@interface Controller : NSObject <NSApplicationDelegate, NSWindowDelegate>
@end
@implementation Controller {
  NSWindow *_window;
  NSTextField *_status;
  ProbeEditor *_editor;
  NSButton *_appKit, *_electron, *_authorize;
  NSString *_kind;
  NSURL *_run;
  NSTask *_target;
  NSDictionary *_before, *_driver;
  InputGate *_gate;
  NSMutableArray<NSNumber *> *_keys;
  NSMutableString *_keyText;
  NSInteger _focusLosses;
  double _start, _end, _deadline;
  BOOL _measuring, _dispatched;
  NSString *_stopReason;
}

- (NSTextField *)label:(NSString *)text frame:(NSRect)frame size:(CGFloat)size {
  NSTextField *label = [NSTextField wrappingLabelWithString:text];
  label.frame = frame;
  label.font = [NSFont systemFontOfSize:size];
  [_window.contentView addSubview:label];
  return label;
}
- (NSButton *)button:(NSString *)text x:(CGFloat)x width:(CGFloat)width action:(SEL)action {
  NSButton *button = [NSButton buttonWithTitle:text target:self action:action];
  button.frame = NSMakeRect(x, 18, width, 34);
  [_window.contentView addSubview:button];
  return button;
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  _window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 650, 295)
                                        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                                          backing:NSBackingStoreBuffered
                                            defer:NO];
  _window.title = @"Zody · 后台操作实验";
  _window.delegate = self;
  [_window center];
  [self label:@"后台 AX 并发实验" frame:NSMakeRect(22, 241, 600, 34) size:23];
  [self label:@"选一组夹具。看到“开始键入”后，切到英文输入，手动依次输入下面 26 个小写字母。每组约需 "
              @"5–10 秒。"
        frame:NSMakeRect(24, 180, 602, 52)
         size:15];
  [self label:Sample frame:NSMakeRect(24, 154, 602, 25) size:18];
  _editor = [[ProbeEditor alloc] initWithFrame:NSMakeRect(24, 97, 602, 48)];
  _editor.font = [NSFont monospacedSystemFontOfSize:19 weight:NSFontWeightRegular];
  _editor.richText = NO;
  _editor.editable = NO;
  _editor.automaticSpellingCorrectionEnabled = NO;
  _editor.automaticTextReplacementEnabled = NO;
  _editor.textContainerInset = NSMakeSize(6, 6);
  __weak Controller *weakSelf = self;
  _editor.noteKey = ^(NSEvent *event) {
    [weakSelf key:event];
  };
  [_window.contentView addSubview:_editor];
  _status = [self label:@"" frame:NSMakeRect(24, 52, 604, 41) size:13];
  _authorize = [self button:@"辅助功能授权" x:18 width:124 action:@selector(authorize:)];
  _appKit = [self button:@"开始 AppKit" x:150 width:123 action:@selector(appKit:)];
  _electron = [self button:@"开始 Electron" x:282 width:136 action:@selector(electron:)];
  [self button:@"停止" x:431 width:77 action:@selector(stop:)];
  [self button:@"查看结果" x:519 width:108 action:@selector(results:)];
  _status.stringValue = AXIsProcessTrusted()
                            ? @"已获辅助功能授权，请选择夹具。"
                            : @"需为 Zody AX Probe 开启“系统设置 → 隐私与安全性 → 辅助功能”。";
  [_window makeKeyAndOrderFront:nil];
  [NSApp activate];
  [NSTimer scheduledTimerWithTimeInterval:0.15
                                  repeats:YES
                                    block:^(NSTimer *timer) {
                                      (void)timer;
                                      [weakSelf tick];
                                    }];
  // 写出实际由 LaunchServices 启动的进程自身的状态，区别于 shell 临时探针。
  [self publishReadiness];
}
- (void)publishReadiness {
  WriteJSON([ProbeRoot() URLByAppendingPathComponent:@"readiness.json"], @{
    @"pid" : @(NSProcessInfo.processInfo.processIdentifier),
    @"trusted" : @(AXIsProcessTrusted()),
    @"date" : @([NSDate.date timeIntervalSince1970])
  },
            nil);
}
- (void)authorize:(id)sender {
  (void)sender;
  NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt : @YES};
  AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
  [self publishReadiness];
}
- (void)results:(id)sender {
  (void)sender;
  [[NSWorkspace sharedWorkspace] openURL:ProbeRoot()];
}
- (void)appKit:(id)sender {
  (void)sender;
  [self start:@"appkit"];
}
- (void)electron:(id)sender {
  (void)sender;
  [self start:@"electron"];
}
- (void)start:(NSString *)kind {
  if (_run || !AXIsProcessTrusted()) return;
  _run = [[ProbeRoot() URLByAppendingPathComponent:@"runs"]
      URLByAppendingPathComponent:NSUUID.UUID.UUIDString];
  NSError *error = nil;
  if (![NSFileManager.defaultManager createDirectoryAtURL:_run
                              withIntermediateDirectories:YES
                                               attributes:@{NSFilePosixPermissions : @0700}
                                                    error:&error]) {
    _status.stringValue = error.localizedDescription;
    _run = nil;
    return;
  }
  _kind = kind;
  _before = nil;
  _driver = nil;
  _stopReason = nil;
  _keys = [NSMutableArray new];
  _keyText = [NSMutableString new];
  _gate = [InputGate new];
  _start = 0;
  _end = 0;
  _focusLosses = 0;
  _dispatched = NO;
  _measuring = NO;
  _deadline = Now() + 20;
  _editor.string = @"";
  _editor.editable = NO;
  _status.stringValue = @"正在启动两扇同名测试窗口…";
  _target = [NSTask new];
  NSBundle *bundle = NSBundle.mainBundle;
  if ([kind isEqual:@"appkit"]) {
    _target.executableURL = [[bundle.executableURL URLByDeletingLastPathComponent]
        URLByAppendingPathComponent:@"probe-target"];
    _target.arguments = @[ _run.path ];
  } else {
    NSString *path = [NSString stringWithContentsOfURL:[bundle URLForResource:@"electron-path"
                                                                withExtension:@"txt"]
                                              encoding:NSUTF8StringEncoding
                                                 error:&error];
    if (!path) {
      [self finish:@"electron-path-missing"];
      return;
    }
    _target.executableURL = [NSURL
        fileURLWithPath:[path stringByTrimmingCharactersInSet:NSCharacterSet
                                                                  .whitespaceAndNewlineCharacterSet]];
    NSString *profile = [_run.path stringByAppendingPathComponent:@"electron-profile"];
    _target.arguments = @[
      [bundle URLForResource:@"electron-target" withExtension:@"cjs"].path, _run.path,
      [@"--user-data-dir=" stringByAppendingString:profile]
    ];
  }
  if (![_target launchAndReturnError:&error]) {
    [self finish:error.localizedDescription];
    return;
  }
}

- (void)key:(NSEvent *)event {
  if (!_measuring || _keys.count >= 27) return;
  NSString *chars = event.characters;
  BOOL plain = !(event.modifierFlags & (NSEventModifierFlagCommand | NSEventModifierFlagControl |
                                        NSEventModifierFlagOption)) &&
               !event.isARepeat;
  // 仅保留本实验固定字符，不记录误键入的个人内容。
  NSUInteger index = _keyText.length;
  BOOL expected = index < Sample.length && plain && chars.length == 1 &&
                  [chars characterAtIndex:0] == [Sample characterAtIndex:index];
  [_keyText appendString:expected ? chars : @"?"];
  [_keys addObject:@(Now())];
  [_gate key];
  if (!_dispatched) [self dispatchActions];
}
- (void)dispatchActions {
  _dispatched = YES;
  NSTask *child = _target;
  InputGate *gate = _gate;
  pid_t pid = child.processIdentifier;
  uint32_t wid = [_before[@"targetWindow"] unsignedIntValue];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    double started = Now();
    NSDictionary *driver = RunBackgroundAXProbe(
        pid, wid,
        ^BOOL {
          return gate.active && child.running;
        },
        ^BOOL {
          return [gate waitForKey];
        });
    double ended = Now();
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self->_gate != gate) return;
      self->_driver = driver;
      self->_start = started;
      self->_end = ended;
      // 效果由目标夹具独立上报，先等待快照反映此次派发，再封存证据。
      [self tick];
    });
  });
}
- (void)lostFocus {
  if (_measuring) {
    _focusLosses++;
    [_gate stop];
  }
}
- (void)applicationDidResignActive:(NSNotification *)n {
  (void)n;
  [self lostFocus];
}
- (void)windowDidResignKey:(NSNotification *)n {
  (void)n;
  [self lostFocus];
}
- (void)stop:(id)sender {
  (void)sender;
  if (!_run) return;
  _stopReason = @"user-stopped";
  [_gate stop];
  if (!_dispatched || _driver) [self finish:_stopReason];
}
- (void)tick {
  BOOL trusted = AXIsProcessTrusted();
  if (_authorize.enabled == trusted) {
    _authorize.enabled = !trusted;
    [self publishReadiness];
  }
  _appKit.enabled = _electron.enabled = !_run && trusted;
  if (!_run) return;
  if (Now() > _deadline || !_target.running || !trusted) {
    if (!_stopReason)
      _stopReason = !trusted ? @"permission-lost" : (!_target.running ? @"target-exited" : @"deadline");
    [_gate stop];
    if (!_dispatched || _driver) [self finish:_stopReason];
    return;
  }
  NSDictionary *state = ReadSnapshot(_run);
  if (!_before) {
    if (!state) return;
    if ([state[@"pid"] intValue] != _target.processIdentifier ||
        [state[@"targetWindow"] longLongValue] <= 0 ||
        [state[@"targetWindow"] longLongValue] > UINT32_MAX ||
        [state[@"siblingWindow"] longLongValue] <= 0 ||
        [state[@"targetWindow"] isEqual:state[@"siblingWindow"]]) {
      [self finish:@"invalid-fixture-identity"];
      return;
    }
    _before = state;
    [_window makeKeyAndOrderFront:nil];
    [NSApp activate];
    _editor.editable = YES;
    [_window makeFirstResponder:_editor];
    _deadline = Now() + 90;
    return;
  }
  if (!_measuring) {
    if (!NSApp.active || !_window.keyWindow || _window.firstResponder != _editor) return;
    _measuring = YES;
    _status.stringValue = @"开始键入 a 到 z。请保持本窗口在前台，直到看到结果。";
  }
  if (!_driver) return;
  if (_stopReason || _focusLosses || ![_driver[@"ok"] boolValue]) {
    [self finish:_stopReason ?: (_focusLosses ? @"focus-lost" : @"driver-refused-or-failed")];
  } else if (_keys.count >= 26 &&
             ([state[@"targetValue"] isEqual:@"probe-value"] || Now() - _end >= 3)) {
    [self finish:@"completed"];
  }
}
- (void)finish:(NSString *)reason {
  [_gate stop];
  NSDictionary *after = ReadSnapshot(_run) ?: @{};
  NSDictionary *front = @{
    @"observed" : @(_measuring),
    @"focusLosses" : @(_focusLosses),
    @"text" : [_editor.string isEqual:Sample] ? Sample : @"",
    @"keyText" : _keyText ?: @"",
    @"keyTimes" : _keys ?: @[],
    @"firstInput" : _keys.firstObject ?: @0,
    @"lastInput" : _keys.lastObject ?: @0,
    @"actionStart" : @(_start),
    @"actionEnd" : @(_end)
  };
  NSDictionary *score = EvaluateProbe(_before ?: @{}, after, front, _driver ?: @{});
  BOOL passed = [reason isEqual:@"completed"] && [score[@"passed"] boolValue];
  NSDictionary *record = @{
    @"fixture" : _kind,
    @"trial" : _run.lastPathComponent,
    @"reason" : reason,
    @"passed" : @(passed),
    @"before" : _before ?: @{},
    @"after" : after,
    @"front" : front,
    @"driver" : _driver ?: @{},
    @"verdict" : score
  };
  NSError *error = nil;
  BOOL saved = WriteJSON([_run URLByAppendingPathComponent:@"result.json"], record, &error);
  _measuring = NO;
  _editor.editable = NO;
  if (_target.running) [_target terminate];
  _status.stringValue = saved ? [NSString stringWithFormat:@"%@ %@ · %@。可查看结果或选择另一组。",
                                                           _kind, passed ? @"通过" : @"未通过", reason]
                              : error.localizedDescription;
  _target = nil;
  _run = nil;
  _gate = nil;
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)app {
  (void)app;
  return YES;
}
- (void)applicationWillTerminate:(NSNotification *)n {
  (void)n;
  [_gate stop];
  if (_target.running) [_target terminate];
}
@end

int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    Controller *controller = [Controller new];
    NSApp.delegate = controller;
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [NSApp run];
  }
  return 0;
}
