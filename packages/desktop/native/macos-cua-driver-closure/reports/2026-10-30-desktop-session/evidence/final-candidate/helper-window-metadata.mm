#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <cstdlib>
int main(int argc,char**argv){@autoreleasepool{if(argc!=2)return 2;int pid=atoi(argv[1]);CFArrayRef a=CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly,kCGNullWindowID);if(!a)return 3;NSMutableArray*result=[NSMutableArray array];for(NSDictionary*w in (__bridge NSArray*)a){if([w[(id)kCGWindowOwnerPID] intValue]!=pid)continue;[result addObject:@{@"pid":@(pid),@"windowId":w[(id)kCGWindowNumber],@"bounds":w[(id)kCGWindowBounds]}];}CFRelease(a);NSData*d=[NSJSONSerialization dataWithJSONObject:result options:0 error:nil];fwrite(d.bytes,1,d.length,stdout);puts("");return result.count?0:4;}}
