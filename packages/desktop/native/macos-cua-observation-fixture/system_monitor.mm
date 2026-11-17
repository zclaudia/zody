#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <IOKit/IOKitLib.h>
#import <SystemConfiguration/SystemConfiguration.h>
#include <signal.h>
#include <cstdlib>
#include <time.h>
#include <unistd.h>
#include "contract.h"
#include "../macos-cua-desktop-session/src/observer_session_status.h"
static volatile sig_atomic_t stopped = 0;
static void Stop(int) { stopped = 1; }
static double Now() { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
static NSString *directory;
static dispatch_queue_t io;
static NSFileHandle *logFile;
static NSUInteger sequence;
static NSUInteger sleepSequence, wakeSequence;
static NSDictionary *Record(NSString *event) {
  NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
  io_registry_entry_t root = IORegistryGetRootEntry(kIOMainPortDefault);
  id locked = root ? CFBridgingRelease(IORegistryEntryCreateCFProperty(root, CFSTR("IOConsoleLocked"), kCFAllocatorDefault, 0)) : nil;
  if (root) IOObjectRelease(root);
  CGDirectDisplayID display = CGMainDisplayID();
  uid_t uid = 0; gid_t gid = 0;
  CFStringRef name = SCDynamicStoreCopyConsoleUser(nullptr, &uid, &gid);
  BOOL consoleKnown = name != nullptr; if (name) CFRelease(name);
  using namespace zody::cua::desktop_session;
  SessionStatus status = observe_session_status();
  ++sequence;
  if ([event isEqual:NSWorkspaceWillSleepNotification]) sleepSequence = sequence;
  if ([event isEqual:NSWorkspaceDidWakeNotification]) wakeSequence = sequence;
  return @{ @"sequence": @(sequence), @"sleepSequence": @(sleepSequence), @"wakeSequence": @(wakeSequence), @"event": event, @"pid": @(getpid()), @"monotonic": @(Now()), @"wallClockUnix": @([[NSDate date] timeIntervalSince1970]),
    @"processUID": @(getuid()), @"consoleUID": consoleKnown ? @(uid) : (id)NSNull.null,
    @"console": StrictState(session[(__bridge NSString *)kCGSessionOnConsoleKey]), @"login": StrictState(session[(__bridge NSString *)kCGSessionLoginDoneKey]),
    @"rootLocked": StrictState(locked), @"cgLocked": StrictState(session[@"CGSSessionScreenIsLocked"]),
    @"displayExists": @(display != 0), @"displayOnline": @(display && CGDisplayIsOnline(display)), @"displayActive": @(display && CGDisplayIsActive(display)), @"displayAsleep": @(!display || CGDisplayIsAsleep(display)),
    @"guard": status == SessionStatus::Allowed ? @"allowed" : status == SessionStatus::Locked ? @"locked" : @"unknown" };
}
static void Save(NSString *event) {
  NSDictionary *record = Record(event);
  dispatch_async(io, ^{
    NSData *json = [NSJSONSerialization dataWithJSONObject:record options:NSJSONWritingSortedKeys error:nil];
    if (!json) exit(3);
    NSMutableData *line = [json mutableCopy]; [line appendBytes:"\n" length:1];
    NSError *error = nil;
    if (![logFile writeData:line error:&error] || ![json writeToFile:[directory stringByAppendingPathComponent:@"latest-system.json"] options:NSDataWritingAtomic error:&error]) exit(3);
  });
}
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if ((argc != 2 && argc != 3) || !ValidRunDirectory([NSString stringWithUTF8String:argv[1]])) return 2;
    long lifetime = 2400;
    if (argc == 3) {
      char *end = nullptr; lifetime = strtol(argv[2], &end, 10);
      if (!end || *end || lifetime < 60 || lifetime > 4200) return 2;
    }
    directory = [NSString stringWithUTF8String:argv[1]];
    NSString *path = [directory stringByAppendingPathComponent:@"system-events.ndjson"];
    if ([[NSFileManager defaultManager] fileExistsAtPath:path]) return 2;
    if (![[NSFileManager defaultManager] createFileAtPath:path contents:[NSData data] attributes:@{ NSFilePosixPermissions: @0600 }]) return 2;
    logFile = [NSFileHandle fileHandleForWritingAtPath:path]; if (!logFile) return 2;
    io = dispatch_queue_create("org.zody.cua.system-monitor.io", DISPATCH_QUEUE_SERIAL);
    signal(SIGTERM, Stop); signal(SIGINT, Stop);
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    NSNotificationCenter *center = NSWorkspace.sharedWorkspace.notificationCenter;
    NSArray *names = @[NSWorkspaceWillSleepNotification, NSWorkspaceDidWakeNotification, NSWorkspaceSessionDidResignActiveNotification, NSWorkspaceSessionDidBecomeActiveNotification, NSWorkspaceActiveSpaceDidChangeNotification, NSWorkspaceScreensDidSleepNotification, NSWorkspaceScreensDidWakeNotification];
    NSMutableArray *tokens = [NSMutableArray array];
    for (NSString *name in names) [tokens addObject:[center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) { Save(notification.name); }]];
    Save(@"ready");
    double start = Now();
    while (!stopped && Now() - start < lifetime) {
      Save(@"sample");
      [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
    }
    Save(@"complete");
    for (id token in tokens) [center removeObserver:token];
    dispatch_sync(io, ^{ [logFile closeFile]; });
  }
  return 0;
}
