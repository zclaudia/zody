#pragma once

#include <string>

#include "bundle_paths.h"
#include "r11_self_identity.h"

namespace zody::cua::round11 {

PinnedIdentity pinned_identity();
ResourcePins resource_pins();
LoadedCodeExpectation node_loaded_code_expectation();

}  // namespace zody::cua::round11
