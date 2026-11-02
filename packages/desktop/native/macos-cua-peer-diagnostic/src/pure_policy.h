#pragma once

#include <string>
#include <vector>

#include "policy.h"
#include "profile.h"

struct PurePolicyValidation {
  bool ok = false;
  std::vector<std::string> errors;
  ExpectedProfile profile;
  PolicyFacts facts;
};

PurePolicyValidation load_pure_policy_inputs(const std::string& profile_path,
                                             const std::string& facts_path);
