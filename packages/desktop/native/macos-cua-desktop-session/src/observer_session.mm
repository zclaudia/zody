#include "observer_session.h"
#include "observer_contract.h"
#import <CoreFoundation/CoreFoundation.h>
#include <cmath>
namespace zody::cua::desktop_session {
namespace {
bool boolean(id value, bool expected) {
  return value && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID() && [value boolValue] == expected;
}
bool bounded_string(id value) {
  if (![value isKindOfClass:[NSString class]]) return false;
  NSData* bytes = [value dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  if (!bytes || bytes.length == 0 || bytes.length > 4096) return false;
  const auto* raw = static_cast<const unsigned char*>(bytes.bytes);
  for (NSUInteger i = 0; i < bytes.length; ++i) if (raw[i] < 0x20 || raw[i] == 0x7f) return false;
  return true;
}
NSDictionary* association(NSDictionary* bootstrap, const std::string& producer) {
  if (![bootstrap isKindOfClass:[NSDictionary class]] || !boolean(bootstrap[@"ok"], true)) return nil;
  NSMutableDictionary* value = [NSMutableDictionary dictionary];
  for (NSString* key in @[@"traceId", @"producerIncarnation", @"runId", @"turnId"]) {
    if (!bounded_string(bootstrap[key])) return nil;
    value[key] = bootstrap[key];
  }
  NSString* expected = [[NSString alloc] initWithBytes:producer.data() length:producer.size() encoding:NSUTF8StringEncoding];
  if (![value[@"producerIncarnation"] isEqual:expected]) return nil;
  NSDictionary* ref = bootstrap[@"ref"];
  if (![ref isKindOfClass:[NSDictionary class]] || ref.count != 7) return nil;
  for (NSString* key in @[@"submissionLineageId", @"appIncarnation", @"hostInstanceId", @"runtimeInstanceId", @"sessionId", @"workspaceKey"]) {
    if (!bounded_string(ref[key])) return nil;
  }
  id revision = ref[@"authorizationRevision"];
  if (![revision isKindOfClass:[NSNumber class]] || boolean(revision, true) || boolean(revision, false)) return nil;
  double raw = [revision doubleValue];
  if (!std::isfinite(raw) || raw < 1 || std::floor(raw) != raw || raw > 9007199254740991.0) return nil;
  value[@"ref"] = ref;
  return value;
}
bool response_live(NSDictionary* response, NSDictionary* scope) {
  if (![response isKindOfClass:[NSDictionary class]] || !boolean(response[@"ok"], true)) return false;
  for (NSString* key in scope) if (![response[key] isEqual:scope[key]]) return false;
  NSDictionary* projection = response[@"projection"];
  return [projection isKindOfClass:[NSDictionary class]] && [projection[@"status"] isEqual:@"candidate"] && [projection[@"ref"] isEqual:scope[@"ref"]];
}
NSString* display_name(const std::string& input) {
  NSString* value = [[NSString alloc] initWithBytes:input.data() length:input.size() encoding:NSUTF8StringEncoding] ?: @"";
  NSMutableString* safe = [NSMutableString string];
  for (NSUInteger i = 0; i < value.length; ++i) {
    const unichar character = [value characterAtIndex:i];
    if (character < 0x20 || character == 0x7f) continue;
    [safe appendFormat:@"%C", character];
  }
  while ([safe lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 128 && safe.length) {
    NSRange last = [safe rangeOfComposedCharacterSequenceAtIndex:safe.length - 1];
    [safe deleteCharactersInRange:last];
  }
  return safe;
}
NSDictionary* target_dictionary(const ObserverWindow& window) {
  const auto& t = window.target;
  return @{ @"pid": @(t.pid), @"windowId": @(t.window_id), @"layer": @(t.layer),
    @"x": @(t.x), @"y": @(t.y), @"width": @(t.width), @"height": @(t.height),
    @"ownerName": display_name(t.owner_name), @"windowName": display_name(t.window_name) };
}
NSDictionary* failure_result(const std::string& reason) {
  NSString* code = [[NSString alloc] initWithBytes:reason.data() length:reason.size() encoding:NSUTF8StringEncoding];
  NSArray* allowed = @[@"permission_denied", @"invalid_request", @"element_unavailable", @"not_authorized", @"screen_locked", @"stale_state", @"structured_state_unavailable", @"action_unavailable", @"timeout", @"broker_unavailable"];
  if (![allowed containsObject:code]) code = @"internal";
  NSData* text = [NSJSONSerialization dataWithJSONObject:@{ @"code": code, @"message": @"Read-only observation failed", @"action_sent": @NO, @"dispatch_status": @"not_sent" } options:0 error:nil];
  return @{ @"isError": @YES, @"content": @[@{ @"type": @"text", @"text": [[NSString alloc] initWithData:text encoding:NSUTF8StringEncoding] }] };
}
NSDictionary* metadata_result(NSArray* rows) {
  NSData* data = rows ? [NSJSONSerialization dataWithJSONObject:rows options:0 error:nil] : nil;
  if (!data) return nil;
  NSDictionary* result = @{ @"content": @[@{ @"type": @"text", @"text": [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] }] };
  NSData* envelope = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
  return envelope && envelope.length <= kObserverMaxMetadataResultBytes ? result : nil;
}
}
bool ObserverSession::run(NSDictionary* bootstrap, const std::string& expected_producer,
                          const ObserverExchange& exchange, const ObserverCancelled& cancelled,
                          ConfirmationController& confirmation, std::string& error) {
  NSDictionary* scope = association(bootstrap, expected_producer);
  if (!scope || !response_live(bootstrap, scope)) { error = "observation-binding-invalid"; return false; }
  const auto check = [&]() {
    if (cancelled(error)) return false;
    NSDictionary* response = exchange(@"check", scope, error);
    return response_live(response, scope) && !cancelled(error);
  };
  const auto send_result = [&](NSDictionary* result) {
    NSMutableDictionary* payload = [scope mutableCopy];
    payload[@"result"] = result;
    NSDictionary* ack = exchange(@"observationResult", payload, error);
    return [ack isKindOfClass:[NSDictionary class]] && ack.count == 2 && boolean(ack[@"ok"], true) && boolean(ack[@"accepted"], true);
  };
  const auto deliver = [&](NSDictionary* result) {
    if (!result || !check()) { state_.clear(); return false; }
    return send_result(result);
  };
  NSDictionary* request = bootstrap[@"observation"];
  if (!observer_request_valid(request)) return deliver(failure_result("invalid_request"));
  if (!check()) { state_.clear(); return false; }
  NSDictionary* args = request[@"arguments"];
  NSString* method = request[@"method"];
  if (![method isEqual:@"get_app_state"]) {
    NSArray* rows = [method isEqual:@"list_apps"] ? source_.apps(error) : source_.windows(args[@"app_ref"], error);
    NSDictionary* result = rows ? metadata_result(rows) : nil;
    return deliver(result ?: failure_result(rows ? "structured_state_unavailable" : error));
  }
  // 原因：像素组合归既有截图链，native 观察切片不暗中创建第二条图像通道。
  if (boolean(args[@"include_screenshot"], true)) return deliver(failure_result("action_unavailable"));
  ObserverWindow window;
  if (!source_.resolve(args[@"app_ref"], window, error)) { observer_diagnostic("resolve_before", error); state_.clear(); return deliver(failure_result(error)); }
  NSMutableDictionary* binding_value = [scope mutableCopy];
  binding_value[@"target"] = @{ @"pid": @(window.target.pid), @"windowId": @(window.target.window_id) };
  SessionBinding binding;
  if (!parse_session_binding(binding_value, binding, error) || !window.target.measured()) return deliver(failure_result("invalid_request"));
  binding.target = window.target;
  if (!check()) return false;
  const uint64_t generation = confirmation.begin(binding);
  if (!generation) return deliver(failure_result("not_authorized"));
  NSMutableDictionary* confirm_payload = [scope mutableCopy];
  confirm_payload[@"generation"] = @(generation);
  confirm_payload[@"target"] = target_dictionary(window);
  NSDictionary* decision = exchange(@"confirmRead", confirm_payload, error);
  if (cancelled(error) || ![decision isKindOfClass:[NSDictionary class]] || !boolean(decision[@"ok"], true)) {
    confirmation.invalidate(generation, "observation-confirmation-invalid");
    return false;
  }
  if (!boolean(decision[@"allowed"], true)) {
    confirmation.resolveFromApp(generation, false);
    return deliver(failure_result("permission_denied"));
  }
  if (!confirmation.resolveFromApp(generation, true) || !check()) return false;
  NSMutableArray* elements = [NSMutableArray array];
  NSMutableArray* handles = [NSMutableArray array];
  bool truncated = false;
  // 这是本分支唯一正文采集点；没有确认和完整 owner 复核永远不可达。
  if (!source_.read(window, elements, handles, truncated, error)) { observer_diagnostic("read", error); state_.clear(); return deliver(failure_result(error)); }
  if (!check()) { state_.clear(); return false; }
  ObserverWindow current;
  NSDictionary* exact_target = @{ @"pid": @(window.target.pid), @"window_id": @(window.target.window_id) };
  if (!source_.resolve(exact_target, current, error)) { observer_diagnostic("resolve_after", error); state_.clear(); return deliver(failure_result(error)); }
  if (!current.window || !window.process_started || ![current.process_started isEqual:window.process_started] ||
      !CFEqual(static_cast<CFTypeRef>(current.window.get()), static_cast<CFTypeRef>(window.window.get()))) {
    observer_diagnostic("resolve_after", "stale_state"); state_.clear(); return deliver(failure_result("stale_state"));
  }
  NSDictionary* state_window = @{ @"pid": @(window.target.pid), @"window_id": @(window.target.window_id), @"window_id_fallback": @NO };
  NSData* scope_bytes = [NSJSONSerialization dataWithJSONObject:scope options:NSJSONWritingSortedKeys error:nil];
  NSString* scope_key = [[NSString alloc] initWithData:scope_bytes encoding:NSUTF8StringEncoding];
  NSArray* native_identity = @[(__bridge id)window.window.get(), window.process_started];
  auto pending = state_.prepare(scope_key, window.app, state_window, native_identity, elements, handles, truncated,
    !boolean(args[@"tree_shown_to_model"], false), boolean(args[@"disable_diffing"], true));
  if (!pending.result) return deliver(failure_result("structured_state_unavailable"));
  if (!check()) { state_.clear(); return false; }
  // 中文原因：最终 authority 往返期间窗口或锁屏状态可能变化，正文交付前必须重新核验，失败不提交基线。
  ObserverWindow final_window;
  if (!source_.resolve(exact_target, final_window, error)) {
    observer_diagnostic("final_resolve", error); state_.clear(); return send_result(failure_result(error));
  }
  if (final_window.target.pid != window.target.pid || final_window.target.window_id != window.target.window_id ||
      !final_window.window || !window.window || !window.process_started ||
      ![final_window.process_started isEqual:window.process_started] ||
      !CFEqual(static_cast<CFTypeRef>(final_window.window.get()), static_cast<CFTypeRef>(window.window.get()))) {
    observer_diagnostic("final_resolve", "stale_state"); state_.clear(); return send_result(failure_result("stale_state"));
  }
  if (!send_result(pending.result)) { state_.clear(); return false; }
  // 只有同一 scope 的 CLI 确认已接受，才允许它成为模型可见基线。
  state_.commit(pending);
  return true;
}
}
