#import <Foundation/Foundation.h>

#include <cstdio>
#include <string>

#include "confirmation_state.h"
#include "session_binding.h"

namespace {

using zody::cua::desktop_session::ConfirmationDecision;
using zody::cua::desktop_session::ConfirmationState;
using zody::cua::desktop_session::SessionBinding;
using zody::cua::desktop_session::parse_session_binding;
using zody::cua::desktop_session::parse_session_binding_json;
using zody::cua::desktop_session::session_binding_json;

int failures = 0;

void expect(bool condition, const char* message) {
  if (condition) return;
  std::fprintf(stderr, "FAIL: %s\n", message);
  failures += 1;
}

NSDictionary* valid_binding_dictionary(NSString* trace_id = @"trace-1") {
  return @{
    @"traceId" : trace_id,
    @"producerIncarnation" : @"producer-1",
    @"runId" : @"run-1",
    @"turnId" : @"turn-1",
    @"ref" : @{
      @"submissionLineageId" : @"lineage-1",
      @"authorizationRevision" : @7,
      @"appIncarnation" : @"app-1",
      @"hostInstanceId" : @"host-1",
      @"runtimeInstanceId" : @"runtime-1",
      @"sessionId" : @"12345678-aaaa-bbbb-cccc-1234567890ab",
      @"workspaceKey" : @"/tmp/workspace-with-\"quote\"-and-\\slash",
    },
    @"target" : @{@"windowId" : @4242, @"pid" : @99},
  };
}

void test_parse_and_roundtrip() {
  SessionBinding binding;
  std::string error;
  expect(parse_session_binding(valid_binding_dictionary(), binding, error), "valid binding rejected");
  expect(binding.valid(), "valid binding not valid");
  expect(binding.authorization_revision == 7, "revision mismatch");
  expect(binding.target.window_id == 4242 && binding.target.pid == 99, "target mismatch");

  const std::string json = session_binding_json(binding);
  expect(!json.empty(), "binding json empty");
  SessionBinding reparsed;
  expect(parse_session_binding_json(json, reparsed, error), "binding json rejected");
  expect(reparsed.same_scope(binding), "binding json roundtrip lost scope");

  const std::string display = binding.display_text();
  expect(display.find("trace-1") == std::string::npos, "confirmation leaked trace id");
  expect(display.find("producer-1") == std::string::npos, "confirmation leaked producer");
  expect(display.find("lineage-1") == std::string::npos, "confirmation leaked ref lineage");
  expect(display.find("12345678") != std::string::npos, "confirmation missing session label");
  expect(display.find("window-with") == std::string::npos, "confirmation should use basename");
}

void test_rejections() {
  SessionBinding binding;
  std::string error;

  expect(!parse_session_binding(valid_binding_dictionary(@"trace\0ambig"), binding, error),
         "embedded NUL accepted");
  expect(!parse_session_binding(valid_binding_dictionary(@"trace\nline"), binding, error),
         "control character accepted");

  NSMutableDictionary* boolean_revision =
      [NSMutableDictionary dictionaryWithDictionary:valid_binding_dictionary()];
  NSMutableDictionary* boolean_ref =
      [NSMutableDictionary dictionaryWithDictionary:boolean_revision[@"ref"]];
  boolean_ref[@"authorizationRevision"] = @YES;
  boolean_revision[@"ref"] = boolean_ref;
  expect(!parse_session_binding(boolean_revision, binding, error), "boolean revision accepted");

  NSMutableDictionary* boolean_window =
      [NSMutableDictionary dictionaryWithDictionary:valid_binding_dictionary()];
  boolean_window[@"target"] = @{@"windowId" : @YES, @"pid" : @99};
  expect(!parse_session_binding(boolean_window, binding, error), "boolean window id accepted");

  NSMutableDictionary* missing_target =
      [NSMutableDictionary dictionaryWithDictionary:valid_binding_dictionary()];
  [missing_target removeObjectForKey:@"target"];
  expect(!parse_session_binding(missing_target, binding, error), "missing target accepted");

  NSMutableDictionary* missing_turn =
      [NSMutableDictionary dictionaryWithDictionary:valid_binding_dictionary()];
  [missing_turn removeObjectForKey:@"turnId"];
  expect(!parse_session_binding(missing_turn, binding, error), "missing turn accepted");

  NSMutableDictionary* missing_session =
      [NSMutableDictionary dictionaryWithDictionary:valid_binding_dictionary()];
  NSMutableDictionary* missing_ref =
      [NSMutableDictionary dictionaryWithDictionary:missing_session[@"ref"]];
  [missing_ref removeObjectForKey:@"sessionId"];
  missing_session[@"ref"] = missing_ref;
  expect(!parse_session_binding(missing_session, binding, error), "missing session accepted");
}

void test_confirmation_state() {
  SessionBinding binding;
  std::string error;
  expect(parse_session_binding(valid_binding_dictionary(), binding, error), "fixture invalid");

  ConfirmationState state;
  const uint64_t first = state.begin(binding);
  expect(state.decision(first) == ConfirmationDecision::Pending, "begin not pending");
  const auto approved = state.approve(first);
  expect(approved.allowed && !approved.late, "first approve rejected");
  const auto second = state.approve(first);
  expect(!second.allowed && second.late, "second approve not rejected as late");

  const uint64_t second_generation = state.begin(binding);
  const auto denied = state.deny(second_generation, "user-canceled");
  expect(!denied.allowed && !denied.late, "deny failed");
  const auto late_approval = state.approve(second_generation);
  expect(!late_approval.allowed && late_approval.late, "late approval after cancel accepted");
  expect(late_approval.reason == "user-canceled", "cancel reason lost");

  const uint64_t third_generation = state.begin(binding);
  const auto invalidated = state.invalidate(third_generation, "owner-revoked");
  expect(!invalidated.allowed, "invalidate allowed");
  const auto after_invalidate = state.approve(third_generation);
  expect(!after_invalidate.allowed && after_invalidate.late,
         "approval after invalidation accepted");

  const uint64_t fourth_generation = state.begin(binding);
  const uint64_t fifth_generation = state.begin(binding);
  expect(fourth_generation != fifth_generation, "generation not advanced");
  const auto old_approval = state.approve(fourth_generation);
  expect(!old_approval.allowed && old_approval.late, "old generation approval accepted");
  expect(state.decision(fifth_generation) == ConfirmationDecision::Pending,
         "new generation not pending");
}

}  // namespace

int main() {
  @autoreleasepool {
    test_parse_and_roundtrip();
    test_rejections();
    test_confirmation_state();
  }
  if (failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", failures);
    return 1;
  }
  std::printf("ok session-binding-confirmation\n");
  return 0;
}
