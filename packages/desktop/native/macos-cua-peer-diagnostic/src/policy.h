#pragma once

#include <string>

#include "profile.h"

struct PolicyFacts {
  bool synthetic = false;
  bool token_captured = false;
  int pid_observed = 0;
  int pid_expected = 0;
  uint32_t euid_observed = 0;
  uint32_t euid_expected = 0;
  bool security_executed = false;
  bool guest_created = false;
  bool adhoc = false;
  bool certificate_present = false;
  bool code_valid = false;
  bool requirement_matched = false;
  std::string identifier;
  std::string leaf_sha256;
  std::string leaf_sha1;
  std::string designated_requirement;
  bool static_artifact_performed = false;
  bool static_artifact_matched = false;
};

struct PolicyDecision {
  bool accepted = false;
  std::string reason;
};

PolicyDecision evaluate_policy(const ExpectedProfile& profile, const PolicyFacts& facts);
