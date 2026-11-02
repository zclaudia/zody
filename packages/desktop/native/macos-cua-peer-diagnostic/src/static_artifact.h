#pragma once

#include <string>
#include <vector>

#include "profile.h"

struct StaticArtifactObservation {
  bool all_performed = false;
  bool matched = false;
  std::string executable_path;
  std::string sha256_expected;
  std::string sha256_actual;
  bool sha256_matched = false;
  std::string entitlements_expected_json;
  std::string entitlements_actual_json;
  bool entitlements_matched = false;
  std::vector<std::string> architectures_expected;
  std::vector<std::string> architectures_actual;
  bool architectures_matched = false;
  std::string minimum_macos_expected;
  std::string minimum_macos_actual;
  bool minimum_macos_matched = false;
  std::vector<std::string> errors;
};

StaticArtifactObservation inspect_static_artifact(
    const std::string& executable_path,
    const ExpectedProfile& profile,
    const std::string& actual_entitlements_json,
    bool entitlements_present);
