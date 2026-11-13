#import "contract.h"
#import <assert.h>

int main() {
  @autoreleasepool {
    assert(!ValidRunDirectory(@"relative"));
    assert(!ValidRunDirectory(@"/definitely/nonexistent/r1-fixture"));
    assert(ValidRunDirectory(@"/tmp"));
    assert(!ValidRunDirectory(@"/tmp/../tmp"));
    assert(![TargetMarker() isEqualToString:SiblingMarker()]);
    assert([TargetMarker() isEqualToString:@"E2E_R1_TARGET_BODY"]);
    assert([SiblingMarker() isEqualToString:@"E2E_R1_SIBLING_BODY"]);
    assert([StrictState(nil)[@"present"] boolValue] == NO);
    assert([StrictState(@YES)[@"value"] boolValue] == YES);
    assert([StrictState(@NO)[@"value"] boolValue] == NO);
    assert(StrictState(@1)[@"value"] == [NSNull null]);
    assert(StrictState(@"true")[@"value"] == [NSNull null]);
    assert([LockClass(@YES, @YES) isEqualToString:@"locked"]);
    assert([LockClass(@NO, @NO) isEqualToString:@"unlocked"]);
    assert([LockClass(@NO, @YES) isEqualToString:@"unknown"]);
    assert([LockClass(nil, @NO) isEqualToString:@"unknown"]);
  }
}
