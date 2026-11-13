#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#import <IOKit/IOKitLib.h>
#import <time.h>
#import <unistd.h>
#include <signal.h>
#import "contract.h"

// 用户完成校准后可中止等待；信号只设置标志，原始采样仍由主循环完整落盘。
static volatile sig_atomic_t stop_requested = 0;
static void StopSampling(int) { stop_requested = 1; }

static double Monotonic(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 4 || strcmp(argv[1], "--seconds") != 0 ||
        !ValidRunDirectory([NSString stringWithUTF8String:argv[3]])) {
      fprintf(stderr, "usage: lock-monitor --seconds 1..900 <existing absolute run directory>\n"); return 2;
    }
    char *end = NULL; long seconds = strtol(argv[2], &end, 10);
    if (!end || *end || seconds < 1 || seconds > 900) { fprintf(stderr, "invalid seconds\n"); return 2; }
    signal(SIGINT, StopSampling);
    signal(SIGTERM, StopSampling);
    NSMutableArray *samples = [NSMutableArray array];
    NSMutableDictionary *counts = [@{@"locked": @0, @"unlocked": @0, @"unknown": @0} mutableCopy];
    double start = Monotonic();
    while (!stop_requested && Monotonic() - start < seconds) {
      @autoreleasepool {
        NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
        id locked = session[@"CGSSessionScreenIsLocked"];
        io_registry_entry_t root = IORegistryGetRootEntry(kIOMainPortDefault);
        id rootLocked = root ? CFBridgingRelease(IORegistryEntryCreateCFProperty(root, CFSTR("IOConsoleLocked"), kCFAllocatorDefault, 0)) : nil;
        if (root) IOObjectRelease(root);
        NSString *classification = LockClass(locked, rootLocked);
        counts[classification] = @([counts[classification] integerValue] + 1);
        [samples addObject:@{@"monotonicSeconds": @(Monotonic()), @"wallClockUnixSeconds": @([[NSDate date] timeIntervalSince1970]),
          @"console": StrictState(session[(__bridge NSString *)kCGSessionOnConsoleKey]),
          @"login": StrictState(session[(__bridge NSString *)kCGSessionLoginDoneKey]),
          @"sessionLocked": StrictState(locked), @"rootLocked": StrictState(rootLocked),
          @"displayAsleep": StrictState(@(CGDisplayIsAsleep(CGMainDisplayID()) != 0)),
          @"classification": classification}];
      }
      usleep(50000);
    }
    NSDictionary *result = @{@"samples": samples, @"counts": counts};
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:&error];
    if (!data || ![data writeToFile:[[NSString stringWithUTF8String:argv[3]] stringByAppendingPathComponent:@"lock-samples.json"] options:NSDataWritingAtomic error:&error]) {
      fprintf(stderr, "sample write failed: %s\n", error.localizedDescription.UTF8String); return 1;
    }
    printf("locked=%ld unlocked=%ld unknown=%ld\n", (long)[counts[@"locked"] integerValue], (long)[counts[@"unlocked"] integerValue], (long)[counts[@"unknown"] integerValue]);
  }
  return 0;
}
