#pragma once

#include <mach/message.h>
#include <cstdint>
#include <string>

#include "profile.h"

struct SecurityObservation {
  bool executed = false;
  bool guest_created = false;
  int guest_status = 0;
  bool code_valid = false;
  int validity_status = 0;
  int check_validity_flags = 0;
  bool signing_info_available = false;
  int signing_status = 0;
  uint32_t flags = 0;
  bool adhoc = false;
  std::string identifier;
  bool certificate_present = false;
  size_t certificate_count = 0;
  std::string leaf_sha256;
  std::string leaf_sha1;
  bool leaf_sha256_matched = false;
  bool leaf_sha1_matched = false;
  std::string designated_requirement;
  std::string expected_designated_requirement;
  bool stored_dr_strict_policy_matched = false;
  int requirement_status = 0;
  bool requirement_matched = false;
  bool static_code_created = false;
  int static_code_status = 0;
  std::string executable_path;
  bool entitlements_present = false;
  std::string entitlements_json;
};

SecurityObservation inspect_peer_security(const audit_token_t& token, const ExpectedProfile& profile);
