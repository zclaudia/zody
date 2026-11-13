#import "explicit_control.h"
#import <AppKit/AppKit.h>
#import <libproc.h>
#import <signal.h>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
static NSString *const kBundle=@"org.zody.cua.explicit-observation-fixture";
bool ExplicitControlIdentity(pid_t pid, NSString *expected, NSString *actual, NSString *bundle, double launch) {
  return pid > 0 && [expected isKindOfClass:[NSString class]] && expected.isAbsolutePath &&
    [expected isEqual:expected.stringByStandardizingPath] && [expected.lastPathComponent isEqual:@"explicit-observation-fixture"] &&
    [expected isEqual:actual] && [bundle isEqual:kBundle] && std::isfinite(launch) && launch > 0;
}
static int failure() { puts("{\"ok\":false}"); return 1; }
int ExplicitControlRun(int argc, const char *argv[]) {
  if (argc != 4 && argc != 5) return failure();
  bool inspect=strcmp(argv[1],"inspect")==0, rebuild=strcmp(argv[1],"rebuild")==0;
  if ((!inspect && !rebuild) || (inspect && argc!=4) || (rebuild && argc!=5)) return failure();
  char *end=nullptr; errno=0; long parsed=strtol(argv[2],&end,10);
  if (errno || !*argv[2] || *end || parsed<=0 || parsed>std::numeric_limits<pid_t>::max()) return failure();
  double expected_launch=0;
  if (rebuild) { errno=0; expected_launch=strtod(argv[4],&end); if (errno || !*argv[4] || *end || !std::isfinite(expected_launch) || expected_launch<=0) return failure(); }
  NSString *expected=[NSString stringWithUTF8String:argv[3]];
  pid_t pid=(pid_t)parsed;
  NSRunningApplication *app=[NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  char path[PROC_PIDPATHINFO_MAXSIZE] = {};
  int length=proc_pidpath(pid,path,sizeof(path));
  NSString *actual=length>0 ? [NSString stringWithUTF8String:path] : nil;
  NSString *app_path=app.executableURL.path;
  double launch=app.launchDate.timeIntervalSince1970;
  if (!ExplicitControlIdentity(pid,expected,actual,app.bundleIdentifier,launch) || ![app_path isEqual:expected] || app.terminated) return failure();
  if (inspect) { printf("{\"ok\":true,\"launchDate\":%.17g}\n",launch); return 0; }
  if (launch!=expected_launch || kill(pid,SIGUSR1)!=0) return failure();
  puts("{\"ok\":true}"); return 0;
}
