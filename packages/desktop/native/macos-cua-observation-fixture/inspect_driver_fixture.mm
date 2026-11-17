#import <AppKit/AppKit.h>
#include <libproc.h>
#include <cstdlib>
int main(int argc, const char *argv[]) { @autoreleasepool {
  if (argc != 4 || argv[2][0] != '/') return 2;
  char *end = nullptr; long pid = strtol(argv[1], &end, 10);
  if (!end || *end || pid <= 0 || pid > INT_MAX) return 2;
  NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)pid];
  char path[PROC_PIDPATHINFO_MAXSIZE] = {}; struct proc_bsdinfo info{};
  NSString *expected = [[NSString stringWithUTF8String:argv[2]] stringByResolvingSymlinksInPath];
  BOOL ok = proc_pidpath((pid_t)pid, path, sizeof(path)) > 0 &&
    proc_pidinfo((pid_t)pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) == sizeof(info) && info.pbi_start_tvsec > 0 &&
    [[[NSString stringWithUTF8String:path] stringByResolvingSymlinksInPath] isEqual:expected] &&
    [app.executableURL.path.stringByResolvingSymlinksInPath isEqual:expected] &&
    [app.bundleIdentifier isEqual:[NSString stringWithUTF8String:argv[3]]];
  // 中文原因：Electron --app 回归壳可能没有 LS launchDate；此工具绑定内核启动时间，不改变生产 AX 的身份合同。
  NSDictionary *result = ok ? @{ @"ok": @YES, @"pid": @(pid), @"launchDate": @[@(info.pbi_start_tvsec), @(info.pbi_start_tvusec)] } : @{ @"ok": @NO };
  NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout); putchar('\n'); return ok ? 0 : 1;
} }
