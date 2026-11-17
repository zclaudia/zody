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
bool control_request_valid(id request) {
  if (![request isKindOfClass:[NSDictionary class]] || [request count] != 2 ||
      !keys(request, [NSSet setWithArray:@[@"method", @"arguments"]])) return false;
  NSString* method=request[@"method"];
  NSDictionary* args=request[@"arguments"];
  if (![method isKindOfClass:[NSString class]] || ![args isKindOfClass:[NSDictionary class]]) return false;
  if ([method isEqual:@"stop_computer_control"]) {
    return keys(args,[NSSet setWithObject:@"reason"]) && (!args[@"reason"] || text(args[@"reason"]));
  }
  if (![method isEqual:@"left_click"] && ![method isEqual:@"perform_action"] && ![method isEqual:@"set_value"]) return false;
  if (!keys(args,[NSSet setWithArray:@[@"target",@"app_ref",@"state_id",@"return_state",@"mouse_button",@"click_count",@"modifiers",@"strategy",@"action",@"value"]]) ||
      !app_ref(args[@"app_ref"]) || !text(args[@"state_id"])) return false;
  NSDictionary* target=args[@"target"];
  if (![target isKindOfClass:[NSDictionary class]] || target.count!=2 || !keys(target,[NSSet setWithArray:@[@"type",@"index"]]) ||
      ![target[@"type"] isEqual:@"element"]) return false;
  id index=target[@"index"];
  if (![index isKindOfClass:[NSNumber class]] || boolean(index) || !std::isfinite([index doubleValue]) ||
      [index doubleValue]<0 || [index doubleValue]>4294967295.0 || std::floor([index doubleValue])!=[index doubleValue]) return false;
  id ret=args[@"return_state"];
  if (ret && ![@[@"none",@"compact",@"full"] containsObject:ret]) return false;
  id strategy=args[@"strategy"];
  if (strategy && ![@[@"auto",@"a11y"] containsObject:strategy]) return false;
  if ([method isEqual:@"left_click"]) {
    if (args[@"action"] || args[@"value"]) return false;
    if (args[@"mouse_button"] && ![args[@"mouse_button"] isEqual:@"left"]) return false;
    if (args[@"click_count"] && (!positive_integer(args[@"click_count"]) || [args[@"click_count"] unsignedIntValue]!=1)) return false;
    if (args[@"modifiers"] && (![args[@"modifiers"] isKindOfClass:[NSArray class]] || [args[@"modifiers"] count]!=0)) return false;
  } else {
    if (args[@"mouse_button"] || args[@"click_count"] || args[@"modifiers"]) return false;
    if ([method isEqual:@"perform_action"]) {
      if (strategy || args[@"value"] || ![args[@"action"] isEqual:@"AXPress"]) return false;
    } else {
      if (args[@"action"] || ![args[@"value"] isKindOfClass:[NSString class]]) return false;
      NSData* value=[args[@"value"] dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
      if (!value || value.length>4096) return false;
    }
  }
  return true;
}
bool observer_request_valid(id request) {
  if (![request isKindOfClass:[NSDictionary class]]) return false;
  NSDictionary* obj = request;
  if (!keys(obj, [NSSet setWithArray:@[@"method", @"arguments"]]) || obj.count != 2 ||
      ![obj[@"method"] isKindOfClass:[NSString class]] || ![obj[@"arguments"] isKindOfClass:[NSDictionary class]]) return false;
  NSString* method = obj[@"method"];
  NSDictionary* args = obj[@"arguments"];
  if ([method isEqualToString:@"commit_state"]) {
    return args.count == 2 && keys(args, [NSSet setWithArray:@[@"app_ref", @"state_id"]]) &&
      app_ref(args[@"app_ref"]) && text(args[@"state_id"]);
  }
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
