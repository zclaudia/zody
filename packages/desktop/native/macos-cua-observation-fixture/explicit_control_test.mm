#import "explicit_control.h"
#include <cassert>
#include <unistd.h>
int main() { @autoreleasepool {
  NSString *p=@"/tmp/ZodyExplicitObservationFixture.app/Contents/MacOS/explicit-observation-fixture";
  NSString *b=@"org.zody.cua.explicit-observation-fixture";
  assert(ExplicitControlIdentity(10,p,p,b,1));
  assert(!ExplicitControlIdentity(-1,p,p,b,1));
  assert(!ExplicitControlIdentity(0,p,p,b,1));
  assert(!ExplicitControlIdentity(10,@"/tmp/../tmp/explicit-observation-fixture",p,b,1));
  assert(!ExplicitControlIdentity(10,p,@"/tmp/other",b,1));
  assert(!ExplicitControlIdentity(10,p,p,@"wrong",1));
  assert(!ExplicitControlIdentity(10,p,p,b,0));
  assert(!ExplicitControlIdentity(10,p,p,b,INFINITY));
  NSString *selfpid=[NSString stringWithFormat:@"%d",getpid()];
  const char *args[]={"fixture-control","inspect",selfpid.UTF8String,p.UTF8String};
  assert(ExplicitControlRun(4,args)!=0);
  const char *bad[]={"fixture-control","rebuild","-1",p.UTF8String,"1"};
  assert(ExplicitControlRun(5,bad)!=0);
} return 0; }
