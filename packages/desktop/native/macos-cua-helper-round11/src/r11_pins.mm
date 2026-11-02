#include "r11_pins.h"

#include "cua_round11_pins.h"

namespace zody::cua::round11 {

PinnedIdentity pinned_identity() {
  PinnedIdentity pinned;
  pinned.bundle_id = CUA_ROUND11_PIN_BUNDLE_ID;
  pinned.leaf_certificate_sha256 = CUA_ROUND11_PIN_LEAF_SHA256;
  pinned.designated_requirement = CUA_ROUND11_PIN_DESIGNATED_REQUIREMENT;
  pinned.configured = !pinned.leaf_certificate_sha256.empty() &&
                      !pinned.designated_requirement.empty();
  return pinned;
}

ResourcePins resource_pins() {
  ResourcePins pins;
  pins.node_sha256 = CUA_ROUND11_PIN_NODE_SHA256;
  pins.authority_sha256 = CUA_ROUND11_PIN_AUTHORITY_SHA256;
  return pins;
}

LoadedCodeExpectation node_loaded_code_expectation() {
  LoadedCodeExpectation expected;
  expected.identifier = CUA_ROUND11_PIN_NODE_IDENTIFIER;
  expected.leaf_certificate_sha256 = CUA_ROUND11_PIN_NODE_LEAF_SHA256;
  expected.designated_requirement = CUA_ROUND11_PIN_NODE_DESIGNATED_REQUIREMENT;
  expected.cdhash_hex = CUA_ROUND11_PIN_NODE_CDHASH;
  expected.require_empty_entitlements = true;
  return expected;
}

}  // namespace zody::cua::round11
