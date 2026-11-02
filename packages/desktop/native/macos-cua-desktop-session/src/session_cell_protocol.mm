#include "session_cell_protocol.h"

#import <CoreFoundation/CoreFoundation.h>

#include "session_transport_auth.h"

#include <cctype>
#include <cmath>
#include <cstring>

namespace zody::cua::desktop_session {
namespace {

bool exact_keys(NSDictionary* dictionary, NSArray<NSString*>* keys) {
  if (![dictionary isKindOfClass:[NSDictionary class]]) return false;
  if (dictionary.count != keys.count) return false;
  for (NSString* key in keys) {
    if (dictionary[key] == nil) return false;
  }
  return true;
}

bool is_cf_number(id value) {
  return value != nil && CFGetTypeID((__bridge CFTypeRef)value) == CFNumberGetTypeID();
}

bool is_cf_string(id value) {
  return value != nil && CFGetTypeID((__bridge CFTypeRef)value) == CFStringGetTypeID();
}

// 中文原因：NSNumber 的布尔 true 与 @1 isEqual: 成立；schemaVersion 必须先按
// CFNumber 排除 CFBoolean，否则 "schemaVersion": true 会被当成版本 1 接收。
bool strict_schema_version_one(id value) {
  if (!is_cf_number(value) || ![value isKindOfClass:[NSNumber class]]) return false;
  return [static_cast<NSNumber*>(value) isEqual:@1];
}

// 中文原因：NSNumber 没有 isEqualToString:，直接调用会让非法 input 抛 ObjC
// 异常而不是明确拒绝。先按 CFString 确认类型再比较。
bool strict_type_is(id value, NSString* expected) {
  if (!is_cf_string(value) || ![value isKindOfClass:[NSString class]]) return false;
  return [static_cast<NSString*>(value) isEqualToString:expected];
}

bool positive_size(id value, size_t max_value, size_t& out) {
  if (!is_cf_number(value) || ![value isKindOfClass:[NSNumber class]]) return false;
  const double raw = [static_cast<NSNumber*>(value) doubleValue];
  // 中文原因：先 isfinite，再做范围比较和 size_t cast；inf/NaN 直接拒绝，避免
  // double->size_t 的未定义行为。
  if (!std::isfinite(raw) || raw < 1 || raw > static_cast<double>(max_value)) return false;
  if (std::floor(raw) != raw) return false;
  out = static_cast<size_t>(raw);
  return true;
}

bool hex_sha256(id value, std::string& out) {
  if (![value isKindOfClass:[NSString class]]) return false;
  NSData* data = [static_cast<NSString*>(value) dataUsingEncoding:NSUTF8StringEncoding
                                              allowLossyConversion:NO];
  if (data == nil || data.length != 64) return false;
  std::string text(static_cast<const char*>(data.bytes), data.length);
  for (char character : text) {
    if (std::isxdigit(static_cast<unsigned char>(character)) == 0) return false;
    if (std::isupper(static_cast<unsigned char>(character)) != 0) return false;
  }
  out = text;
  return true;
}

std::string json_line(NSDictionary* frame) {
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:frame
                                                options:NSJSONWritingSortedKeys
                                                  error:&error];
  if (data == nil || error != nil) return "";
  std::string line(static_cast<const char*>(data.bytes), data.length);
  line.push_back('\n');
  return line;
}

}  // namespace

bool parse_cell_open_frame(NSDictionary* frame, CellOpenRequest& request, std::string& error) {
  request = CellOpenRequest();
  if (!exact_keys(frame, @[ @"schemaVersion", @"type", @"sourceSha256", @"challenge",
                            @"requestMaxBytes", @"responseMaxBytes" ])) {
    error = "cell-open-shape-invalid";
    return false;
  }
  if (!strict_schema_version_one(frame[@"schemaVersion"])) {
    error = "cell-open-schema-unsupported";
    return false;
  }
  if (!strict_type_is(frame[@"type"], @"cell-open")) {
    error = "cell-open-type-invalid";
    return false;
  }
  if (!hex_sha256(frame[@"sourceSha256"], request.source_sha256)) {
    error = "cell-open-source-sha-invalid";
    return false;
  }
  if (!hex_sha256(frame[@"challenge"], request.challenge_hex) ||
      !is_valid_transport_challenge(request.challenge_hex)) {
    error = "cell-open-challenge-invalid";
    return false;
  }
  if (!positive_size(frame[@"requestMaxBytes"], kCellMaxRequestBytes, request.request_max_bytes)) {
    error = "cell-open-request-bound-invalid";
    return false;
  }
  if (!positive_size(frame[@"responseMaxBytes"], kCellMaxResponseBytes,
                     request.response_max_bytes)) {
    error = "cell-open-response-bound-invalid";
    return false;
  }
  return true;
}

bool parse_cell_open_line(const std::string& line, size_t max_bytes, CellOpenRequest& request,
                          std::string& error) {
  if (line.size() > max_bytes) {
    error = "cell-open-frame-too-large";
    return false;
  }
  id value = nil;
  @autoreleasepool {
    NSData* data = [NSData dataWithBytes:line.data() length:line.size()];
    NSError* json_error = nil;
    value = [NSJSONSerialization JSONObjectWithData:data options:0 error:&json_error];
    if (json_error != nil || value == nil || ![value isKindOfClass:[NSDictionary class]]) {
      error = "cell-open-json-invalid";
      return false;
    }
  }
  return parse_cell_open_frame(static_cast<NSDictionary*>(value), request, error);
}

bool is_fixed_cell_reason(const std::string& reason) {
  if (reason.empty() || reason.size() > 256) return false;
  for (unsigned char byte : reason) {
    if (byte < 0x20 || byte == 0x7f) return false;
  }
  return true;
}

std::string serialize_cell_ready(pid_t cell_pid) {
  // 中文原因：proof 必须先于原 cell-ready 独立返回并由 CLI 校验；cellPid 只在
  // proof 成功后交付，不把未认证的 PID 塞进同一个 ready 帧冒充身份。
  if (cell_pid <= 0) return "";
  return json_line(@{
    @"schemaVersion" : @1,
    @"type" : @"cell-ready",
    @"cellPid" : @(cell_pid),
  });
}

std::string serialize_cell_error(const std::string& reason) {
  if (!is_fixed_cell_reason(reason)) return "";
  NSString* text = [NSString stringWithUTF8String:reason.c_str()];
  if (text == nil) return "";
  return json_line(@{
    @"schemaVersion" : @1,
    @"type" : @"cell-error",
    @"reason" : text,
  });
}

std::string serialize_cell_exit(bool reaped, bool exited, int exit_code, bool signaled,
                                int signal_value) {
  id exit_value = exited ? static_cast<id>(@(exit_code)) : static_cast<id>([NSNull null]);
  id signal_out =
      signaled ? static_cast<id>(@(signal_value)) : static_cast<id>([NSNull null]);
  return json_line(@{
    @"schemaVersion" : @1,
    @"type" : @"cell-exit",
    @"reaped" : @(reaped),
    @"exitCode" : exit_value,
    @"signal" : signal_out,
  });
}

}  // namespace zody::cua::desktop_session
