#import <AppKit/AppKit.h>
#import <signal.h>
#import <unistd.h>

@interface Probe : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property(nonatomic, strong) NSWindow *target;
@property(nonatomic, strong) NSWindow *sibling;
@property(nonatomic, strong) NSTextField *targetField;
@property(nonatomic, strong) NSTextField *siblingField;
@property(nonatomic, copy) NSString *directory;
@property(nonatomic) NSInteger targetClicks;
@property(nonatomic) NSInteger siblingClicks;
@property(nonatomic) pid_t parent;
@property(nonatomic, strong) NSData *lastSnapshot;
@end

@implementation Probe
- (void)flush {
  NSDictionary *state = @{
    @"pid" : @(getpid()),
    @"targetWindow" : @(self.target.windowNumber),
    @"siblingWindow" : @(self.sibling.windowNumber),
    @"targetClicks" : @(self.targetClicks),
    @"siblingClicks" : @(self.siblingClicks),
    @"targetValue" : self.targetField.stringValue,
    @"siblingValue" : self.siblingField.stringValue
  };
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:state
                                                 options:NSJSONWritingSortedKeys
                                                   error:&error];
  if (data && [data isEqualToData:self.lastSnapshot]) return;
  if (!data || ![data writeToFile:[self.directory stringByAppendingPathComponent:@"target.json"]
                          options:NSDataWritingAtomic
                            error:&error]) {
    fprintf(stderr, "fixture state write failed: %s\n", error.localizedDescription.UTF8String);
    exit(1);
  }
  self.lastSnapshot = data;
}
- (void)clicked:(NSButton *)sender {
  if (sender.tag == 1)
    self.targetClicks++;
  else
    self.siblingClicks++;
  [self flush];
}
- (NSWindow *)windowAt:(NSRect)frame field:(NSTextField **)outField tag:(NSInteger)tag {
  NSWindow *window =
      [[NSWindow alloc] initWithContentRect:frame
                                  styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                                    backing:NSBackingStoreBuffered
                                      defer:NO];
  window.title = @"Background AX Probe";
  window.releasedWhenClosed = NO;
  window.delegate = self;
  NSButton *button = [NSButton buttonWithTitle:@"Probe Button" target:self action:@selector(clicked:)];
  button.frame = NSMakeRect(20, 75, 160, 30);
  button.tag = tag;
  [button setAccessibilityLabel:@"Probe Button"];
  [window.contentView addSubview:button];
  NSTextField *field = [[NSTextField alloc] initWithFrame:NSMakeRect(20, 25, 220, 28)];
  [field setAccessibilityLabel:@"Probe Field"];
  [window.contentView addSubview:field];
  *outField = field;
  [window orderFrontRegardless];
  return window;
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  NSTextField *targetField = nil, *siblingField = nil;
  self.target = [self windowAt:NSMakeRect(80, 350, 300, 150) field:&targetField tag:1];
  self.sibling = [self windowAt:NSMakeRect(410, 350, 300, 150) field:&siblingField tag:2];
  self.targetField = targetField;
  self.siblingField = siblingField;
  if (self.target.windowNumber <= 0 || self.sibling.windowNumber <= 0 ||
      self.target.windowNumber == self.sibling.windowNumber) {
    fprintf(stderr, "invalid fixture window mapping\n");
    exit(1);
  }
  [self flush];
  [NSTimer scheduledTimerWithTimeInterval:0.1
                                  repeats:YES
                                    block:^(NSTimer *timer) {
                                      (void)timer;
                                      if (getppid() != self.parent || kill(self.parent, 0) != 0) {
                                        [NSApp terminate:nil];
                                        return;
                                      }
                                      [self flush];
                                    }];
}
- (void)windowWillClose:(NSNotification *)notification {
  (void)notification;
  [NSApp terminate:nil];
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    BOOL isDirectory = NO;
    if (argc != 2 || argv[1][0] != '/' ||
        ![[NSFileManager defaultManager] fileExistsAtPath:[NSString stringWithUTF8String:argv[1]]
                                              isDirectory:&isDirectory] ||
        !isDirectory) {
      fprintf(stderr, "expected an existing absolute run directory\n");
      return 2;
    }
    Probe *probe = [Probe new];
    probe.directory = [NSString stringWithUTF8String:argv[1]];
    probe.parent = getppid();
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp setDelegate:probe];
    [NSApp run];
  }
  return 0;
}
