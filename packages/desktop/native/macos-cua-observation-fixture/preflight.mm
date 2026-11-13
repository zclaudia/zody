#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#include <cassert>

// 只投影调用方指定的窗口；未知枚举结果保留 null，不能当成不在屏幕或通过。
static NSDictionary *WindowFact(pid_t pid, uint32_t wid, NSArray *all, NSArray *visible) {
  NSDictionary *match = nil;
  for (NSDictionary *entry in all) {
    if ([entry[(__bridge NSString *)kCGWindowOwnerPID] intValue] == pid &&
        [entry[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] == wid) {
      match = entry;
      break;
    }
  }
  id layer = [NSNull null], boundsValid = [NSNull null], onscreen = [NSNull null];
  if (match) {
    id rawLayer = match[(__bridge NSString *)kCGWindowLayer];
    if ([rawLayer isKindOfClass:[NSNumber class]]) layer = rawLayer;
    CGRect rect = CGRectZero;
    id bounds = match[(__bridge NSString *)kCGWindowBounds];
    if ([bounds isKindOfClass:[NSDictionary class]]) {
      bool valid = CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds, &rect);
      boundsValid = @(valid && rect.size.width > 0 && rect.size.height > 0);
    }
  }
  if (visible) {
    BOOL found = NO;
    for (NSDictionary *entry in visible) {
      if ([entry[(__bridge NSString *)kCGWindowOwnerPID] intValue] == pid &&
          [entry[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] == wid) { found = YES; break; }
    }
    onscreen = @(found);
  }
  return @{@"windowID": @(wid), @"layer": layer, @"boundsValid": boundsValid, @"onscreen": onscreen};
}
static bool PositiveInteger(id value, uint32_t &out) {
  if (![value isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return false;
  double n = [value doubleValue];
  if (n < 1 || n > UINT32_MAX || n != (uint32_t)n) return false;
  out = (uint32_t)n;
  return true;
}
static int SelfTest() {
  NSDictionary *a = @{(__bridge NSString *)kCGWindowOwnerPID:@123, (__bridge NSString *)kCGWindowNumber:@7,
    (__bridge NSString *)kCGWindowLayer:@0, (__bridge NSString *)kCGWindowBounds:@{@"X":@1,@"Y":@2,@"Width":@100,@"Height":@50}};
  NSDictionary *other = @{(__bridge NSString *)kCGWindowOwnerPID:@456, (__bridge NSString *)kCGWindowNumber:@7};
  NSDictionary *fact = WindowFact(123, 7, @[other,a], @[other,a]);
  assert([fact[@"layer"] intValue] == 0 && [fact[@"boundsValid"] boolValue] && [fact[@"onscreen"] boolValue]);
  assert(![WindowFact(123, 7, @[a], @[other])[@"onscreen"] boolValue]);
  assert(WindowFact(123, 7, nil, nil)[@"onscreen"] == [NSNull null]);
  assert(WindowFact(123, 8, @[a], @[])[@"layer"] == [NSNull null]);
  uint32_t n = 0; assert(PositiveInteger(@7,n) && n == 7);
  assert(!PositiveInteger(@YES,n) && !PositiveInteger(@0,n) && !PositiveInteger(@1.5,n));
  return 0;
}
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) return SelfTest();
    if (argc != 2 || argv[1][0] != '/') { fprintf(stderr, "expected absolute manifest path\n"); return 2; }
    NSData *bytes = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[1]]];
    id manifest = bytes ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil] : nil;
    uint32_t pid, target, sibling;
    if (![manifest isKindOfClass:[NSDictionary class]] || !PositiveInteger(manifest[@"pid"],pid) ||
        pid > INT32_MAX || !PositiveInteger(manifest[@"targetWindow"],target) ||
        !PositiveInteger(manifest[@"siblingWindow"],sibling) || target == sibling) {
      fprintf(stderr, "invalid fixture manifest\n"); return 2;
    }
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)pid];
    NSArray *all = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSArray *visible = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSDictionary *result = @{@"pid": @(pid), @"launchDatePresent": app ? @(app.launchDate != nil) : [NSNull null],
      @"hidden": app ? @(app.hidden) : [NSNull null], @"windowIDs": @[
        WindowFact((pid_t)pid,target,all,visible), WindowFact((pid_t)pid,sibling,all,visible)]};
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:nil];
    if (!json) { fprintf(stderr, "preflight serialization failed\n"); return 1; }
    fwrite(json.bytes,1,json.length,stdout); fputc('\n',stdout);
    return 0;
  }
}
