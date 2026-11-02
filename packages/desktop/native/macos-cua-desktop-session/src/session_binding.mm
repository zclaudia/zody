#include "session_binding.h"

#import <CoreFoundation/CoreFoundation.h>

#include <cmath>
#include <cstdlib>
#include <string>

namespace zody::cua::desktop_session {
namespace {

constexpr size_t kMaxFieldBytes = 4 * 1024;

bool is_boolean_number(id value) {
  return CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

bool strict_utf8(NSString* value, std::string& out) {
  NSData* data = [value dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  if (data == nil) return false;
  const size_t length = data.length;
  if (length == 0 || length > kMaxFieldBytes) return false;
  const unsigned char* bytes = static_cast<const unsigned char*>(data.bytes);
  for (size_t index = 0; index < length; ++index) {
    // 中文原因：嵌入 NUL 会被 UTF8String 提前截断，必须按 NSData 长度保留并显式拒绝；
    // 其余 C0/DEL 控制字符也不属于任何合法身份字段。
    if (bytes[index] < 0x20 || bytes[index] == 0x7f) return false;
  }
  out.assign(reinterpret_cast<const char*>(bytes), length);
  return true;
}

bool bounded_string(NSString* value, std::string& out) {
  if (![value isKindOfClass:[NSString class]]) return false;
  return strict_utf8(value, out);
}

bool bounded_string_value(id value, std::string& out) {
  return [value isKindOfClass:[NSString class]] && bounded_string(static_cast<NSString*>(value), out);
}

bool number_int64(id value, int64_t& out) {
  if (![value isKindOfClass:[NSNumber class]]) return false;
  if (is_boolean_number(value)) return false;
  const double raw = [static_cast<NSNumber*>(value) doubleValue];
  if (!std::isfinite(raw) || std::floor(raw) != raw) return false;
  if (raw <= 0 || raw > 9.007199254740991e15) return false;
  out = static_cast<int64_t>(raw);
  return true;
}

bool number_u32(id value, uint32_t& out) {
  if (![value isKindOfClass:[NSNumber class]]) return false;
  if (is_boolean_number(value)) return false;
  const double raw = [static_cast<NSNumber*>(value) doubleValue];
  if (!std::isfinite(raw) || std::floor(raw) != raw || raw <= 0 || raw > 4294967295.0) {
    return false;
  }
  out = static_cast<uint32_t>(raw);
  return true;
}

bool number_i32(id value, int32_t& out) {
  if (![value isKindOfClass:[NSNumber class]]) return false;
  if (is_boolean_number(value)) return false;
  const double raw = [static_cast<NSNumber*>(value) doubleValue];
  if (!std::isfinite(raw) || std::floor(raw) != raw || raw < -2147483648.0 ||
      raw > 2147483647.0) {
    return false;
  }
  out = static_cast<int32_t>(raw);
  return true;
}

NSString* ns_string(const std::string& value) {
  return [[NSString alloc] initWithBytes:value.data()
                                  length:value.size()
                                encoding:NSUTF8StringEncoding];
}

std::string shorten(const std::string& value, size_t head, size_t tail) {
  if (value.size() <= head + tail + 1) return value;
  return value.substr(0, head) + "…" + value.substr(value.size() - tail);
}

std::string workspace_label(const std::string& workspace) {
  if (workspace.empty()) return "";
  const size_t slash = workspace.find_last_of('/');
  if (slash == std::string::npos || slash + 1 >= workspace.size()) return workspace;
  return workspace.substr(slash + 1);
}

}  // namespace

bool SessionTarget::measured() const {
  return identified() && std::isfinite(x) && std::isfinite(y) && std::isfinite(width) &&
         std::isfinite(height) && width > 0 && height > 0;
}

bool SessionTarget::same_identity(const SessionTarget& other) const {
  return window_id == other.window_id && pid == other.pid;
}

bool SessionTarget::same_bounds(const SessionTarget& other) const {
  return x == other.x && y == other.y && width == other.width && height == other.height;
}

bool SessionBinding::valid() const {
  return !trace_id.empty() && !producer_incarnation.empty() && !run_id.empty() &&
         !turn_id.empty() && !submission_lineage_id.empty() && !app_incarnation.empty() &&
         !host_instance_id.empty() && !runtime_instance_id.empty() && !session_id.empty() &&
         !workspace_key.empty() && authorization_revision > 0 && target.identified();
}

bool SessionBinding::same_scope(const SessionBinding& other) const {
  return trace_id == other.trace_id && producer_incarnation == other.producer_incarnation &&
         run_id == other.run_id && turn_id == other.turn_id &&
         submission_lineage_id == other.submission_lineage_id &&
         app_incarnation == other.app_incarnation &&
         host_instance_id == other.host_instance_id &&
         runtime_instance_id == other.runtime_instance_id && session_id == other.session_id &&
         workspace_key == other.workspace_key &&
         authorization_revision == other.authorization_revision &&
         target.same_identity(other.target);
}

std::string SessionBinding::display_text() const {
  std::string text;
  text += "会话: " + shorten(session_id, 8, 4) + "\n";
  text += "工作区: " + workspace_label(workspace_key) + "\n";
  text += "应用: " + (target.owner_name.empty() ? "未知" : target.owner_name) + "\n";
  text += "窗口: " + (target.window_name.empty() ? "未命名" : target.window_name) + "\n";
  text += "PID: " + std::to_string(target.pid) + "    Window ID: " +
          std::to_string(target.window_id);
  return text;
}

bool parse_session_binding(NSDictionary* value, SessionBinding& binding, std::string& error) {
  binding = SessionBinding();
  if (value == nil || ![value isKindOfClass:[NSDictionary class]]) {
    error = "binding-not-object";
    return false;
  }
  if (!bounded_string_value(value[@"traceId"], binding.trace_id) ||
      !bounded_string_value(value[@"producerIncarnation"], binding.producer_incarnation) ||
      !bounded_string_value(value[@"runId"], binding.run_id) ||
      !bounded_string_value(value[@"turnId"], binding.turn_id)) {
    error = "binding-identity-missing";
    return false;
  }
  NSDictionary* ref = value[@"ref"];
  if (ref == nil || ![ref isKindOfClass:[NSDictionary class]]) {
    error = "binding-ref-missing";
    return false;
  }
  if (!bounded_string_value(ref[@"submissionLineageId"], binding.submission_lineage_id) ||
      !bounded_string_value(ref[@"appIncarnation"], binding.app_incarnation) ||
      !bounded_string_value(ref[@"hostInstanceId"], binding.host_instance_id) ||
      !bounded_string_value(ref[@"runtimeInstanceId"], binding.runtime_instance_id) ||
      !bounded_string_value(ref[@"sessionId"], binding.session_id) ||
      !bounded_string_value(ref[@"workspaceKey"], binding.workspace_key)) {
    error = "binding-ref-incomplete";
    return false;
  }
  if (!number_int64(ref[@"authorizationRevision"], binding.authorization_revision)) {
    error = "binding-revision-invalid";
    return false;
  }
  NSDictionary* target = value[@"target"];
  if (target == nil || ![target isKindOfClass:[NSDictionary class]]) {
    error = "binding-target-missing";
    return false;
  }
  if (!number_u32(target[@"windowId"], binding.target.window_id) ||
      !number_i32(target[@"pid"], binding.target.pid)) {
    error = "binding-target-invalid";
    return false;
  }
  if (!binding.valid()) {
    error = "binding-incomplete";
    return false;
  }
  return true;
}

bool parse_session_binding_json(const std::string& json, SessionBinding& binding,
                                std::string& error) {
  NSData* data = [NSData dataWithBytes:json.data() length:json.size()];
  if (data == nil) {
    error = "binding-json-empty";
    return false;
  }
  NSError* json_error = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&json_error];
  if (parsed == nil || json_error != nil || ![parsed isKindOfClass:[NSDictionary class]]) {
    error = "binding-json-invalid";
    return false;
  }
  return parse_session_binding(static_cast<NSDictionary*>(parsed), binding, error);
}

std::string session_binding_json(const SessionBinding& binding) {
  // 中文原因：手工转义容易漏掉 \b/\f/全部 C0 控制字符；统一交给
  // NSJSONSerialization，避免两份 JSON 编码规则漂移。
  NSDictionary* ref = session_ref_dictionary(binding);
  NSDictionary* target = session_target_dictionary(binding);
  NSDictionary* root = @{
    @"traceId" : ns_string(binding.trace_id),
    @"producerIncarnation" : ns_string(binding.producer_incarnation),
    @"runId" : ns_string(binding.run_id),
    @"turnId" : ns_string(binding.turn_id),
    @"ref" : ref,
    @"target" : target,
  };
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:root
                                                options:NSJSONWritingSortedKeys
                                                  error:&error];
  if (data == nil || error != nil) return "";
  return std::string(static_cast<const char*>(data.bytes), data.length);
}

NSDictionary* session_ref_dictionary(const SessionBinding& binding) {
  return @{
    @"submissionLineageId" : ns_string(binding.submission_lineage_id),
    @"authorizationRevision" : @(binding.authorization_revision),
    @"appIncarnation" : ns_string(binding.app_incarnation),
    @"hostInstanceId" : ns_string(binding.host_instance_id),
    @"runtimeInstanceId" : ns_string(binding.runtime_instance_id),
    @"sessionId" : ns_string(binding.session_id),
    @"workspaceKey" : ns_string(binding.workspace_key),
  };
}

NSDictionary* session_target_dictionary(const SessionBinding& binding) {
  return @{
    @"windowId" : @(binding.target.window_id),
    @"pid" : @(binding.target.pid),
    @"layer" : @(binding.target.layer),
    @"x" : @(binding.target.x),
    @"y" : @(binding.target.y),
    @"width" : @(binding.target.width),
    @"height" : @(binding.target.height),
    @"ownerName" : ns_string(binding.target.owner_name),
    @"windowName" : ns_string(binding.target.window_name),
  };
}

}  // namespace zody::cua::desktop_session
