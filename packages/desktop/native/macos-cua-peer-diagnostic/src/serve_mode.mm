#include <unistd.h>

#include <cerrno>
#include <climits>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "calibration_profile.h"
#include "cli_common.h"
#include "peer_socket.h"
#include "policy.h"
#include "profile.h"
#include "report.h"
#include "security_identity.h"
#include "static_artifact.h"

int run_serve(const std::vector<std::string>& args) {
  Options options;
  std::string error;
  if (!parse_options(args, 2, options, error) ||
      !only_options(options,
                    {"--workdir", "--profile", "--calibration-profile", "--expect-pid",
                     "--expect-uid", "--timeout-ms"},
                    error)) {
    emit_blocked_report("serve", "invalid-arguments", {error});
    return 2;
  }
  std::string workdir;
  if (!required_option(options, "--workdir", workdir, error)) {
    emit_blocked_report("serve", "workdir-missing", {error});
    return 2;
  }
  const bool has_profile = options.values.count("--profile") != 0;
  const bool has_calibration = options.values.count("--calibration-profile") != 0;
  if (!has_profile && !has_calibration) {
    emit_blocked_report("serve", "profile-missing",
                        {"no pinned local-self-signed profile or calibration profile was supplied"});
    return 2;
  }
  if (has_profile && has_calibration) {
    emit_blocked_report("serve", "profile-selection-invalid",
                        {"exactly one of --profile or --calibration-profile is required"});
    return 2;
  }
  ExpectedProfile profile;
  bool calibration_only = false;
  if (has_profile) {
    const ProfileValidation validation = load_and_validate_profile(options.values["--profile"]);
    if (!validation.ok) {
      emit_blocked_report("serve", "profile-invalid", validation.errors);
      return 2;
    }
    profile = validation.profile;
  } else {
    const CalibrationValidation validation =
        load_and_validate_calibration_profile(options.values["--calibration-profile"]);
    if (!validation.ok) {
      emit_blocked_report("serve", "calibration-profile-invalid", validation.errors);
      return 2;
    }
    profile = validation.profile;
    calibration_only = true;
  }

  long long expected_pid = 0;
  long long expected_uid = 0;
  long long timeout_ms = kDefaultTimeoutMs;
  std::string ignored;
  if (!required_option(options, "--expect-pid", ignored, error) ||
      !parse_integer(options.values["--expect-pid"], 1, INT_MAX, expected_pid) ||
      !required_option(options, "--expect-uid", ignored, error) ||
      !parse_integer(options.values["--expect-uid"], 0, UINT32_MAX, expected_uid) ||
      !option_int(options, "--timeout-ms", kDefaultTimeoutMs, 100, 300000, timeout_ms, error)) {
    emit_blocked_report("serve", "expectation-invalid", {error});
    return 2;
  }
  if (!validate_private_workdir(workdir, error)) {
    emit_blocked_report("serve", "workdir-unusable", {error});
    return 2;
  }

  const std::string socket_path = peer_socket_path(workdir);
  int listener_fd = -1;
  SocketOwnership ownership;
  if (!create_private_listener(socket_path, listener_fd, ownership, error)) {
    emit_transport_error_report("serve", "listener-unavailable: " + error, errno);
    return 1;
  }
  int client_fd = -1;
  if (!accept_one_with_deadline(listener_fd, static_cast<int>(timeout_ms), client_fd, error)) {
    close_owned_socket(listener_fd, socket_path, ownership);
    emit_transport_error_report("serve", "accept-failed: " + error, errno);
    return 1;
  }
  close(listener_fd);
  listener_fd = -1;

  PeerToken token;
  if (!read_peer_token(client_fd, token, error)) {
    close(client_fd);
    close_owned_socket(-1, socket_path, ownership);
    emit_transport_error_report("serve", "peer-token-failed: " + error, token.error);
    return 1;
  }
  std::string request;
  if (!read_bounded_frame(client_fd, kMaxRequestBytes, static_cast<int>(timeout_ms), request,
                          error)) {
    close(client_fd);
    close_owned_socket(-1, socket_path, ownership);
    emit_transport_error_report("serve", "frame-read-failed: " + error, errno);
    return 1;
  }
  if (request != kRequest) {
    close(client_fd);
    close_owned_socket(-1, socket_path, ownership);
    emit_transport_error_report("serve", "unexpected-frame", EINVAL);
    return 1;
  }

  const SecurityObservation security = inspect_peer_security(token.token, profile);
  const StaticArtifactObservation artifact = inspect_static_artifact(
      security.executable_path, profile, security.entitlements_json,
      security.entitlements_present);
  PolicyFacts facts;
  facts.synthetic = false;
  facts.token_captured = token.captured;
  facts.pid_observed = token.pid;
  facts.pid_expected = static_cast<int>(expected_pid);
  facts.euid_observed = token.euid;
  facts.euid_expected = static_cast<uint32_t>(expected_uid);
  facts.security_executed = security.executed;
  facts.guest_created = security.guest_created;
  facts.adhoc = security.adhoc;
  facts.certificate_present = security.certificate_present;
  facts.code_valid = security.code_valid;
  facts.requirement_matched = security.requirement_matched;
  facts.identifier = security.identifier;
  facts.leaf_sha256 = security.leaf_sha256;
  facts.leaf_sha1 = security.leaf_sha1;
  facts.designated_requirement = security.designated_requirement;
  facts.static_artifact_performed = artifact.all_performed;
  facts.static_artifact_matched = artifact.matched;
  PolicyDecision decision = evaluate_policy(profile, facts);
  if (calibration_only && decision.accepted) {
    decision.accepted = false;
    decision.reason = "calibration-control-only";
  }

  const std::string mode = calibration_only ? "calibration-serve" : "serve";
  const std::string response = render_peer_report(mode, token, static_cast<int>(expected_pid),
                                                  static_cast<uint32_t>(expected_uid), security,
                                                  artifact, decision, calibration_only);
  if (response.empty()) {
    close(client_fd);
    close_owned_socket(-1, socket_path, ownership);
    emit_transport_error_report("serve", "json-serialization-failed", 0);
    return 1;
  }
  if (!write_bounded_frame(client_fd, response, static_cast<int>(timeout_ms), error)) {
    close(client_fd);
    close_owned_socket(-1, socket_path, ownership);
    emit_transport_error_report("serve", "response-write-failed: " + error, errno);
    return 1;
  }
  close(client_fd);
  close_owned_socket(-1, socket_path, ownership);
  emit_raw_json(response);
  return 0;
}
