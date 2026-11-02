#include "peer_auth.h"

#include "peer_socket.h"
#include "profile.h"
#include "security_identity.h"

#include <string>

namespace zody::cua::round11 {
namespace {

constexpr uint32_t kCsRuntime = 0x00010000U;

bool has_forbidden_entitlement(const std::string& json) {
  return json.find("disable-library-validation") != std::string::npos ||
         json.find("allow-dyld-environment-variables") != std::string::npos ||
         json.find("get-task-allow") != std::string::npos;
}

PeerAuthResult evaluate(int fd, const PeerExpectation& expectation) {
  PeerAuthResult result;
  PeerToken token;
  std::string error;
  if (!read_peer_token(fd, token, error)) {
    result.reason = "peer-token-failed";
    return result;
  }
  result.token_captured = token.captured;
  result.peer_pid = token.pid;
  result.peer_uid = token.euid;

  if (expectation.pid <= 0 || token.pid != expectation.pid) {
    result.reason = "peer-pid-mismatch";
    return result;
  }
  if (token.euid != expectation.uid) {
    result.reason = "peer-uid-mismatch";
    return result;
  }

  ExpectedProfile profile;
  profile.bundle_id = expectation.bundle_id;
  profile.leaf_certificate_sha256 = expectation.leaf_certificate_sha256;
  profile.designated_requirement = expectation.designated_requirement;
  const SecurityObservation security = inspect_peer_security(token.token, profile);

  result.guest_created = security.guest_created;
  result.code_valid = security.code_valid;
  result.adhoc = security.adhoc;
  result.certificate_present = security.certificate_present;
  result.flags = security.flags;
  result.hardened_runtime = (security.flags & kCsRuntime) != 0;
  result.leaf_matched = !expectation.leaf_certificate_sha256.empty() &&
                        security.leaf_sha256 == expectation.leaf_certificate_sha256;
  result.requirement_matched = security.requirement_matched &&
                               !expectation.designated_requirement.empty() &&
                               security.designated_requirement ==
                                   expectation.designated_requirement;
  result.identifier_matched = !expectation.bundle_id.empty() &&
                              security.identifier == expectation.bundle_id;
  result.identifier = security.identifier;
  result.leaf_sha256 = security.leaf_sha256;
  result.designated_requirement = security.designated_requirement;
  result.entitlements_empty =
      !security.entitlements_present || security.entitlements_json == "{}";

  if (!security.executed || !security.guest_created) {
    result.reason = "peer-security-unavailable";
    return result;
  }
  if (!security.code_valid) {
    result.reason = "peer-code-invalid";
    return result;
  }
  if (security.adhoc) {
    result.reason = "peer-ad-hoc";
    return result;
  }
  if (!security.certificate_present) {
    result.reason = "peer-missing-certificate";
    return result;
  }
  if (!result.hardened_runtime) {
    result.reason = "peer-hardened-runtime-missing";
    return result;
  }
  if (has_forbidden_entitlement(security.entitlements_json)) {
    result.reason = "peer-forbidden-entitlement";
    return result;
  }
  if (expectation.require_empty_entitlements && !result.entitlements_empty) {
    result.reason = "peer-unexpected-entitlements";
    return result;
  }
  if (!result.identifier_matched) {
    result.reason = "peer-identifier-mismatch";
    return result;
  }
  if (!result.leaf_matched) {
    result.reason = "peer-leaf-mismatch";
    return result;
  }
  if (!result.requirement_matched) {
    result.reason = "peer-designated-requirement-mismatch";
    return result;
  }
  result.ok = true;
  result.reason = "accepted";
  return result;
}

}  // namespace

PeerAuthResult authenticate_peer_fd(int fd, const PeerExpectation& expectation) {
  return evaluate(fd, expectation);
}

bool supervisor_handshake(int fd, const PeerExpectation& expectation, PeerAuthResult& result,
                          std::string& error) {
  std::string hello;
  if (!read_bounded_frame(fd, 64, 5'000, hello, error) || hello != "HELLO") {
    if (error.empty()) error = "unexpected helper hello";
    return false;
  }
  result = authenticate_peer_fd(fd, expectation);
  if (!result.ok) {
    error = result.reason;
    return false;
  }
  if (!write_bounded_frame(fd, "HELLO_OK", 5'000, error)) return false;
  return true;
}

bool helper_handshake(int fd, const PeerExpectation& expectation, PeerAuthResult& result,
                      std::string& error) {
  result = authenticate_peer_fd(fd, expectation);
  if (!result.ok) {
    error = result.reason;
    return false;
  }
  if (!write_bounded_frame(fd, "HELLO", 5'000, error)) return false;
  std::string response;
  if (!read_bounded_frame(fd, 64, 5'000, response, error) || response != "HELLO_OK") {
    if (error.empty()) error = "unexpected supervisor hello response";
    return false;
  }
  return true;
}

}  // namespace zody::cua::round11
