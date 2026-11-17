#import <AppKit/AppKit.h>
#include <libproc.h>
#include <limits.h>
#include <cstdlib>
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 4 || argv[2][0] != '/') return 2;
    char *end = nullptr; long value = strtol(argv[1], &end, 10);
    if (!end || *end || value <= 0 || value > INT_MAX) return 2;
    NSString *expected = [[NSString stringWithUTF8String:argv[2]] stringByResolvingSymlinksInPath];
    NSString *bundle = [NSString stringWithUTF8String:argv[3]];
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)value];
    char path[PROC_PIDPATHINFO_MAXSIZE] = {};
    bool obtained = proc_pidpath((pid_t)value, path, sizeof(path)) > 0;
    NSString *actual = obtained ? [[NSString stringWithUTF8String:path] stringByResolvingSymlinksInPath] : nil;
    BOOL matches = app && app.launchDate && [actual isEqual:expected] && [app.executableURL.path.stringByResolvingSymlinksInPath isEqual:expected] && [app.bundleIdentifier isEqual:bundle];
    NSDictionary *result = matches ? @{ @"ok": @YES, @"pid": @(value), @"launchDate": @([app.launchDate timeIntervalSince1970]) } : @{ @"ok": @NO };
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    fwrite(json.bytes, 1, json.length, stdout); putchar('\n');
    return matches ? 0 : 1;
  }
}
