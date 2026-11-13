#import <Foundation/Foundation.h>
#include <sys/types.h>
bool ExplicitControlIdentity(pid_t pid, NSString *expected, NSString *actual, NSString *bundle, double launch);
int ExplicitControlRun(int argc, const char *argv[]);
