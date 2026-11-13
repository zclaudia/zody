#import "verdict.h"
#include <stdio.h>
#include <stdlib.h>

static void expect(BOOL condition, const char *name) {
  if (!condition) {
    fprintf(stderr, "FAIL: %s\n", name);
    exit(1);
  }
}
static BOOL pass(NSDictionary *b, NSDictionary *a, NSDictionary *f, NSDictionary *d) {
  return [EvaluateProbe(b, a, f, d)[@"passed"] boolValue];
}
int main() {
  @autoreleasepool {
    NSDictionary *b = @{
      @"pid" : @1,
      @"targetWindow" : @2,
      @"siblingWindow" : @3,
      @"targetClicks" : @0,
      @"siblingClicks" : @0,
      @"targetValue" : @"",
      @"siblingValue" : @""
    };
    NSMutableDictionary *a = [b mutableCopy];
    a[@"targetClicks"] = @1;
    a[@"targetValue"] = @"probe-value";
    NSMutableArray *times = [NSMutableArray array];
    for (int i = 0; i < 26; i++) [times addObject:@(i + 1)];
    NSMutableDictionary *f = [@{
      @"observed" : @YES,
      @"focusLosses" : @0,
      @"text" : @"abcdefghijklmnopqrstuvwxyz",
      @"keyText" : @"abcdefghijklmnopqrstuvwxyz",
      @"firstInput" : @1,
      @"lastInput" : @26,
      @"actionStart" : @10,
      @"actionEnd" : @15,
      @"keyTimes" : times
    } mutableCopy];
    NSDictionary *d = @{@"ok" : @YES};
    expect(pass(b, a, f, d), "positive");
    NSMutableDictionary *x = [a mutableCopy];
    x[@"targetClicks"] = @0;
    expect(!pass(b, x, f, d), "click without effect");
    x = [a mutableCopy];
    x[@"targetValue"] = @"other";
    expect(!pass(b, x, f, d), "wrong target value");
    x = [a mutableCopy];
    x[@"targetWindow"] = @4;
    expect(!pass(b, x, f, d), "changed identity");
    x = [a mutableCopy];
    x[@"siblingClicks"] = @1;
    expect(!pass(b, x, f, d), "sibling changed");
    x = [f mutableCopy];
    x[@"focusLosses"] = @1;
    expect(!pass(b, a, x, d), "brief focus loss");
    x = [f mutableCopy];
    x[@"observed"] = @NO;
    expect(!pass(b, a, x, d), "missing observer");
    x = [f mutableCopy];
    [x removeObjectForKey:@"keyTimes"];
    expect(!pass(b, a, x, d), "missing trace");
    x = [f mutableCopy];
    x[@"keyText"] = @"abcdefghijklmnopqrstuvwxy";
    expect(!pass(b, a, x, d), "dropped key");
    x = [f mutableCopy];
    x[@"text"] = @"";
    expect(!pass(b, a, x, d), "redirected keys");
    x = [f mutableCopy];
    x[@"actionStart"] = @0;
    expect(!pass(b, a, x, d), "late typing");
    x = [f mutableCopy];
    x[@"actionEnd"] = @26;
    expect(!pass(b, a, x, d), "no input after end");
    x = [f mutableCopy];
    x[@"actionStart"] = @10.1;
    x[@"actionEnd"] = @10.9;
    expect(!pass(b, a, x, d), "bracket without overlapping key");
    x = [f mutableCopy];
    x[@"firstInput"] = @0;
    expect(!pass(b, a, x, d), "forged first input");
    expect(!pass(b, a, f, @{@"ok" : @NO}), "driver failure");
    expect(!pass(b, a, f, @{@"ok" : @1}), "boolean schema");
    puts("verdict tests passed");
  }
  return 0;
}
