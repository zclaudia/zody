#import "verdict.h"
#import <CoreFoundation/CoreFoundation.h>
#include <cmath>

static BOOL number(id value) {
  return [value isKindOfClass:[NSNumber class]] &&
         CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() &&
         std::isfinite([value doubleValue]);
}
static BOOL boolean(id value) {
  return value && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}
static BOOL integer(id value, double minimum) {
  return number(value) && [value doubleValue] >= minimum &&
         floor([value doubleValue]) == [value doubleValue];
}
static BOOL snapshot(id v) {
  if (![v isKindOfClass:[NSDictionary class]]) return NO;
  return integer(v[@"pid"], 1) && integer(v[@"targetWindow"], 1) && integer(v[@"siblingWindow"], 1) &&
         ![v[@"targetWindow"] isEqual:v[@"siblingWindow"]] && integer(v[@"targetClicks"], 0) &&
         integer(v[@"siblingClicks"], 0) && [v[@"targetValue"] isKindOfClass:[NSString class]] &&
         [v[@"siblingValue"] isKindOfClass:[NSString class]];
}
NSDictionary *EvaluateProbe(NSDictionary *before, NSDictionary *after, NSDictionary *front,
                            NSDictionary *driver) {
  NSMutableDictionary *checks = [NSMutableDictionary dictionary];
  BOOL snapshots = snapshot(before) && snapshot(after);
  checks[@"snapshotsValid"] = @(snapshots);
  checks[@"stableIdentity"] = @(snapshots && [before[@"pid"] isEqual:after[@"pid"]] &&
                                [before[@"targetWindow"] isEqual:after[@"targetWindow"]] &&
                                [before[@"siblingWindow"] isEqual:after[@"siblingWindow"]]);
  checks[@"targetEffect"] =
      @(snapshots && [before[@"targetClicks"] doubleValue] == 0 &&
        [before[@"targetValue"] isEqualToString:@""] && [after[@"targetClicks"] doubleValue] == 1 &&
        [after[@"targetValue"] isEqualToString:@"probe-value"]);
  checks[@"siblingUnchanged"] = @(snapshots && [before[@"siblingClicks"] doubleValue] == 0 &&
                                  [before[@"siblingValue"] isEqualToString:@""] &&
                                  [before[@"siblingClicks"] isEqual:after[@"siblingClicks"]] &&
                                  [before[@"siblingValue"] isEqual:after[@"siblingValue"]]);
  BOOL validDriver = [driver isKindOfClass:[NSDictionary class]] && boolean(driver[@"ok"]);
  checks[@"driverOk"] = @(validDriver && [driver[@"ok"] boolValue]);
  BOOL validFront =
      [front isKindOfClass:[NSDictionary class]] && boolean(front[@"observed"]) &&
      integer(front[@"focusLosses"], 0) && [front[@"text"] isKindOfClass:[NSString class]] &&
      [front[@"keyText"] isKindOfClass:[NSString class]] &&
      [front[@"keyTimes"] isKindOfClass:[NSArray class]] && number(front[@"firstInput"]) &&
      number(front[@"lastInput"]) && number(front[@"actionStart"]) && number(front[@"actionEnd"]);
  checks[@"frontValid"] = @(validFront);
  BOOL trace = validFront && [front[@"keyTimes"] count] == 26 &&
               [front[@"keyText"] isEqualToString:@"abcdefghijklmnopqrstuvwxyz"] &&
               [front[@"text"] isEqualToString:@"abcdefghijklmnopqrstuvwxyz"];
  double prev = -1;
  NSUInteger inside = 0, afterStart = 0;
  if (trace) {
    for (id item in front[@"keyTimes"]) {
      if (!number(item) || [item doubleValue] < 0 || [item doubleValue] < prev) {
        trace = NO;
        break;
      }
      double t = [item doubleValue];
      prev = t;
      if (t >= [front[@"actionStart"] doubleValue] && t <= [front[@"actionEnd"] doubleValue]) inside++;
      if (t > [front[@"actionStart"] doubleValue]) afterStart++;
    }
  }
  // 首末时间必须来自实际逐键事件，不能用人工填充的边界冒充输入证据。
  if (trace)
    trace = [front[@"firstInput"] doubleValue] == [front[@"keyTimes"][0] doubleValue] &&
            [front[@"lastInput"] doubleValue] == [[front[@"keyTimes"] lastObject] doubleValue];
  checks[@"traceValid"] = @(trace);
  checks[@"focusPreserved"] = @(validFront && [front[@"observed"] boolValue] &&
                                [front[@"focusLosses"] unsignedLongLongValue] == 0);
  BOOL bracket = trace && [front[@"actionStart"] doubleValue] >= 0 &&
                 [front[@"actionStart"] doubleValue] <= [front[@"actionEnd"] doubleValue] &&
                 [front[@"firstInput"] doubleValue] <= [front[@"actionStart"] doubleValue] &&
                 [front[@"lastInput"] doubleValue] > [front[@"actionEnd"] doubleValue] &&
                 afterStart > 0;
  checks[@"bracketed"] = @(bracket);
  checks[@"overlap"] = @(bracket && inside > 0);
  BOOL passed = YES;
  for (NSNumber *check in checks.allValues)
    if (![check boolValue]) passed = NO;
  return @{@"passed" : @(passed), @"checks" : checks, @"keysInsideAction" : @(inside)};
}
