#import <Foundation/Foundation.h>
#import "explicit_manifest.h"
#include <cassert>
int main() { @autoreleasepool {
  NSString *dir=[NSTemporaryDirectory() stringByAppendingPathComponent:[[NSUUID UUID] UUIDString]];
  assert([[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:NO attributes:nil error:nil]);
  NSString *path=[dir stringByAppendingPathComponent:@"manifest.json"];
  ExplicitManifestWriter *writer=[ExplicitManifestWriter new];
  __block int completed=0; __block BOOL failed=NO;
  [writer writeData:[@"first" dataUsingEncoding:NSUTF8StringEncoding] path:path completion:^(BOOL ok) { ++completed; failed |= !ok; }];
  [writer writeData:[@"second" dataUsingEncoding:NSUTF8StringEncoding] path:path completion:^(BOOL ok) { ++completed; failed |= !ok; }];
  [writer flush];
  assert(completed==2 && !failed);
  assert([[NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil] isEqual:@"second"]);
  assert([[NSFileManager defaultManager] removeItemAtPath:dir error:nil]);
} return 0; }
