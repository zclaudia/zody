#import <Foundation/Foundation.h>
#import <CoreFoundation/CoreFoundation.h>

static NSString *TargetMarker(void) { return @"E2E_R1_TARGET_BODY"; }
static NSString *SiblingMarker(void) { return @"E2E_R1_SIBLING_BODY"; }
static BOOL ValidRunDirectory(NSString *path) {
  if (![path isAbsolutePath] || ![path isEqualToString:path.stringByStandardizingPath]) return NO;
  BOOL directory = NO;
  return [[NSFileManager defaultManager] fileExistsAtPath:path isDirectory:&directory] && directory;
}
// 严格区分 CFBoolean 和 NSNumber；缺失或异常类型不能成为锁定事实。
static NSDictionary *StrictState(id value) {
  if (!value) return @{@"present": @NO, @"type": @"missing", @"value": [NSNull null]};
  BOOL boolean = CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
  return @{@"present": @YES, @"type": boolean ? @"boolean" : @"other", @"value": boolean ? value : [NSNull null]};
}
static NSString *LockClass(id session, id root) {
  NSDictionary *s = StrictState(session), *r = StrictState(root);
  if (![s[@"type"] isEqual:@"boolean"] || ![r[@"type"] isEqual:@"boolean"] ||
      [s[@"value"] boolValue] != [r[@"value"] boolValue]) return @"unknown";
  return [s[@"value"] boolValue] ? @"locked" : @"unlocked";
}
