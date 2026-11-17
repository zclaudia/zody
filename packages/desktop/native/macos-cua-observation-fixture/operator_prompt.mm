#import <AppKit/AppKit.h>
#include <cstdio>
@interface OperatorPrompt : NSObject <NSApplicationDelegate>
@property(copy) NSString *output;
@property(copy) NSString *phase;
@property NSTimeInterval waitSeconds;
@end
@implementation OperatorPrompt
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    NSString *output = self.output, *phase = self.phase;
    NSDictionary *instructions = @{
      @"sleep": @"点击开始后，测试器会自动让 Mac 睡眠。约 5 秒后按键唤醒，在锁屏画面再停留约 5 秒，然后正常解锁；不要退出测试应用。返回后无需输入字符，等待后续提示。",
      @"switch": @"点击开始后，用系统的切换用户功能进入登录窗口，停留约 10 秒，再返回当前账户。无需创建账户，也不要把密码输入本测试窗口。",
      @"input": @"点击开始后，在测试输入窗口按住数字 1。听到结束提示或窗口关闭后松开。不需要输入 26 个字母。",
      @"input-stop": @"输入采集已结束，现在请松开数字 1，再点击“已松开”。下一阶段不需要继续键入。",
      @"clipboard-space": @"点击开始后，在测试输入窗口按 Command+A、Command+C，只复制夹具测试数字。然后按 Control+右箭头切到另一个已有桌面，再按 Control+左箭头返回；不要创建新桌面。完成后等待结束提示。若本机只有一个桌面，回到聊天说明即可。",
      @"calibration-done": @"本次校准采集已结束，无需继续操作。结果将独立核验，缺失项目不会记为通过。",
      @"clipboard": @"在测试输入窗口选择已有测试数字并按 Command+C 复制；完成后回到聊天告知。不要复制其他应用的数据。",
      @"space": @"松开按键后，切换到另一个已有桌面空间，再切回本桌面。若没有其他桌面空间，稍后在聊天说明。"
    };
    NSString *instruction = instructions[phase]; if (!instruction) exit(2);
    NSAlert *alert = [NSAlert new];
    alert.messageText = [@"R1 验收：现在开始 — " stringByAppendingString:phase];
    alert.informativeText = instruction;
    [alert addButtonWithTitle:[phase isEqual:@"input-stop"] ? @"已松开" : [phase isEqual:@"calibration-done"] ? @"完成" : @"开始"];
    [alert addButtonWithTitle:@"先暂停"];
    alert.window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
    alert.window.level = NSModalPanelWindowLevel;
    NSDictionary *identity = @{ @"pid": @(NSProcessInfo.processInfo.processIdentifier), @"launchDate": @([NSRunningApplication.currentApplication.launchDate timeIntervalSince1970]), @"phase": phase, @"bundleId": NSBundle.mainBundle.bundleIdentifier ?: @"", @"executable": NSBundle.mainBundle.executablePath ?: @"" };
    NSData *started = [NSJSONSerialization dataWithJSONObject:identity options:0 error:nil];
    [started writeToFile:[output stringByAppendingString:@".ready.json"] options:NSDataWritingAtomic error:nil];
    [NSApp activateIgnoringOtherApps:YES]; [alert.window orderFrontRegardless]; NSBeep();
    __block BOOL expired = NO;
    NSTimer *deadline = [NSTimer timerWithTimeInterval:self.waitSeconds repeats:NO block:^(NSTimer *timer) { (void)timer; expired = YES; [NSApp stopModalWithCode:NSAlertSecondButtonReturn]; }];
    [[NSRunLoop mainRunLoop] addTimer:deadline forMode:NSModalPanelRunLoopMode];
    NSModalResponse response = [alert runModal]; [deadline invalidate];
    NSDictionary *answer = @{ @"ready": @(response == NSAlertFirstButtonReturn), @"source": @"native-user-alert", @"outcome": expired ? @"timeout" : response == NSAlertFirstButtonReturn ? @"user-start" : @"user-pause", @"phase": phase };
    NSData *data = [NSJSONSerialization dataWithJSONObject:answer options:0 error:nil];
    if (![data writeToFile:output options:NSDataWritingAtomic error:nil]) exit(4);
    [NSApp terminate:nil];
}
@end
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if ((argc != 3 && argc != 4) || argv[2][0] != '/') return 2;
    long waitSeconds = 300;
    if (argc == 4) { char *end = nullptr; waitSeconds = strtol(argv[3], &end, 10); if (!argv[3][0] || *end || waitSeconds < 60 || waitSeconds > 1800) return 2; }
    OperatorPrompt *delegate = [OperatorPrompt new];
    delegate.output = [NSString stringWithUTF8String:argv[2]];
    delegate.phase = [NSString stringWithUTF8String:argv[1]];
    delegate.waitSeconds = waitSeconds;
    // 中文原因：先完成标准启动握手再显示提示，避免 LaunchServices 等待未完成启动而丢失就绪答复。
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [NSApp setDelegate:delegate]; [NSApp run];
  }
  return 0;
}
