#pragma once

#include <string>
#include <vector>

struct ExpectedProfile {
  std::string bundle_id;
  std::string executable_name;
  std::string leaf_certificate_sha256;
  std::string certificate_sha1;
  std::string designated_requirement;
  std::string executable_sha256;
  std::string minimum_macos_version;
  std::vector<std::string> architectures;
  std::string entitlements_json;
  bool usable = false;
  bool calibration_only = false;
};

struct ProfileValidation {
  bool ok = false;
  std::vector<std::string> errors;
  ExpectedProfile profile;
};

ProfileValidation load_and_validate_profile(const std::string& path);
ProfileValidation validate_profile_json(const std::string& text);
bool parse_narrow_requirement(const std::string& text, std::string& identifier, std::string& certificate_sha1);
