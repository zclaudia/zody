#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <cstdlib>
int main(int argc, const char** argv) {
 @autoreleasepool {
  if(argc!=2) return 2; const pid_t target=atoi(argv[1]);
  NSArray* list=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID));
  NSMutableArray* matches=[NSMutableArray array];
  for(NSDictionary* w in list) if([w[(id)kCGWindowOwnerPID] intValue]==target && [w[(id)kCGWindowLayer] intValue]==0)
   [matches addObject:@{@"pid":w[(id)kCGWindowOwnerPID],@"windowId":w[(id)kCGWindowNumber],@"bounds":w[(id)kCGWindowBounds]}];
  NSData* data=[NSJSONSerialization dataWithJSONObject:matches options:NSJSONWritingPrettyPrinted error:nil];
  fwrite(data.bytes,1,data.length,stdout); putchar('\n'); return matches.count?0:1;
 }
}
