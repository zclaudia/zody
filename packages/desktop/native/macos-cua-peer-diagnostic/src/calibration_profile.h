#pragma once

#include <string>
#include <vector>

#include "profile.h"

struct CalibrationValidation {
  bool ok = false;
  std::vector<std::string> errors;
  ExpectedProfile profile;
};

CalibrationValidation load_and_validate_calibration_profile(const std::string& path);
