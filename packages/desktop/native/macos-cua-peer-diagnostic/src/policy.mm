#include "policy.h"

#include <string>

namespace {

PolicyDecision reject(const char* reason) {
  PolicyDecision decision;
  decision.accepted = false;
  decision.reason = reason;
  return decision;
}

}  // namespace

PolicyDecision evaluate_policy(const ExpectedProfile& profile, const PolicyFacts& facts) {
  if (!facts.synthetic) {
    if (!facts.token_captured) {
      return reject("missing-peer-token");
    }
    if (facts.pid_observed != facts.pid_expected) {
      return reject("peer-pid-mismatch");
    }
    if (facts.euid_observed != facts.euid_expected) {
      return reject("peer-uid-mismatch");
    }
    if (!facts.security_executed) {
      return reject("security-not-executed");
    }
    if (!facts.guest_created) {
      return reject("security-guest-unavailable");
    }
  }
  if (facts.adhoc) {
    return reject("ad-hoc-signature");
  }
  if (!facts.certificate_present) {
    return reject("missing-certificate");
  }
  if (!facts.code_valid) {
    return reject("code-validity-failed");
  }
  if (!facts.requirement_matched) {
    return reject("code-requirement-not-matched");
  }
  if (facts.identifier.empty() || facts.identifier != profile.bundle_id) {
    return reject("identifier-mismatch");
  }
  if (facts.leaf_sha256.empty() || facts.leaf_sha256 != profile.leaf_certificate_sha256) {
    return reject("leaf-sha256-mismatch");
  }
  if (facts.leaf_sha1.empty() || facts.leaf_sha1 != profile.certificate_sha1) {
    return reject("designated-requirement-leaf-mismatch");
  }
  std::string actual_identifier;
  std::string actual_certificate_sha1;
  if (!parse_narrow_requirement(facts.designated_requirement, actual_identifier,
                                actual_certificate_sha1)) {
    return reject("designated-requirement-mismatch");
  }
  if (actual_identifier != profile.bundle_id ||
      actual_certificate_sha1 != profile.certificate_sha1) {
    return reject("designated-requirement-mismatch");
  }
  if (!facts.synthetic) {
    if (!facts.static_artifact_performed) {
      return reject("static-artifact-check-incomplete");
    }
    if (!facts.static_artifact_matched) {
      return reject("static-artifact-mismatch");
    }
  }
  PolicyDecision decision;
  decision.accepted = true;
  decision.reason = facts.synthetic ? "synthetic-policy-accepted" : "accepted";
  return decision;
}
