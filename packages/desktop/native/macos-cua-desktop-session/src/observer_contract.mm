#include "observer_contract.h"
#import <CoreFoundation/CoreFoundation.h>
#include <cmath>
namespace zody::cua::desktop_session {
namespace {
bool keys(NSDictionary* value, NSSet<NSString*>* allowed) {
  for (id key in value) if (![key isKindOfClass:[NSString class]] || ![allowed containsObject:key]) return false;
  return true;
}
bool boolean(id value) { return value && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID(); }
bool positive_integer(id value) {
  if (![value isKindOfClass:[NSNumber class]] || boolean(value)) return false;
  double n = [value doubleValue];
  return std::isfinite(n) && n > 0 && n <= 4294967295.0 && std::floor(n) == n;
}
bool text(id value) {
  if (![value isKindOfClass:[NSString class]]) return false;
  NSData* data = [value dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  if (!data || data.length == 0 || data.length > 4096 ||
      [[value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] length] == 0) return false;
  const auto* bytes = static_cast<const unsigned char*>(data.bytes);
  for (NSUInteger i = 0; i < data.length; ++i) if (bytes[i] < 0x20 || bytes[i] == 0x7f) return false;
  return true;
}
bool app_ref(id value) {
  if ([value isKindOfClass:[NSString class]]) return text(value) && [[value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] length] > 0;
  if (![value isKindOfClass:[NSDictionary class]]) return false;
  NSDictionary* ref = value;
  if (!keys(ref, [NSSet setWithArray:@[@"pid", @"window_id", @"name", @"bundle_id"]])) return false;
  if (!ref[@"pid"] && !ref[@"name"] && !ref[@"bundle_id"]) return false;
  for (NSString* key in @[@"pid", @"window_id"]) if (ref[key] && !positive_integer(ref[key])) return false;
  for (NSString* key in @[@"name", @"bundle_id"]) if (ref[key] && !text(ref[key])) return false;
  return true;
}
}
bool observer_request_valid(id request) {
  if (![request isKindOfClass:[NSDictionary class]]) return false;
  NSDictionary* obj = request;
  if (!keys(obj, [NSSet setWithArray:@[@"method", @"arguments"]]) || obj.count != 2 ||
      ![obj[@"method"] isKindOfClass:[NSString class]] || ![obj[@"arguments"] isKindOfClass:[NSDictionary class]]) return false;
  NSString* method = obj[@"method"];
  NSDictionary* args = obj[@"arguments"];
  if ([method isEqualToString:@"list_apps"]) return args.count == 0;
  if ([method isEqualToString:@"list_windows"]) {
    return keys(args, [NSSet setWithObject:@"app_ref"]) && (!args[@"app_ref"] || app_ref(args[@"app_ref"]));
  }
  if (![method isEqualToString:@"get_app_state"] ||
      !keys(args, [NSSet setWithArray:@[@"app_ref", @"include_screenshot", @"disable_diffing", @"tree_shown_to_model"]]) || !app_ref(args[@"app_ref"])) return false;
  for (NSString* key in @[@"include_screenshot", @"disable_diffing", @"tree_shown_to_model"]) if (args[key] && !boolean(args[key])) return false;
  return true;
}
}
