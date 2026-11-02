#pragma once

#include <string>

namespace zody::cua::round11 {

struct PinnedIdentity {
  std::string bundle_id;
  std::string leaf_certificate_sha256;
  std::string designated_requirement;
  bool configured = false;
};

struct SelfPreflight {
  bool ok = false;
  std::string reason;
  bool pin_configured = false;
  bool code_created = false;
  bool code_valid = false;
  bool static_code_created = false;
  bool resource_seal_valid = false;
  bool signing_information_available = false;
  bool adhoc = false;
  bool certificate_present = false;
  bool hardened_runtime = false;
  bool leaf_pin_matched = false;
  bool designated_requirement_matched = false;
  bool identifier_matched = false;
  bool entitlements_present = false;
  bool forbidden_entitlements_present = false;
  bool entitlements_empty = false;
  std::string identifier;
  std::string leaf_sha256;
  std::string designated_requirement;
  std::string entitlements_json;
};

// 只用编译期 pin 校验 self；不读取 bundle 自带 profile 或任何线上 peer 身份。
SelfPreflight evaluate_self_preflight(const PinnedIdentity& pinned);

struct LoadedCodeExpectation {
  std::string identifier;
  std::string leaf_certificate_sha256;
  std::string designated_requirement;
  std::string cdhash_hex;
  bool require_empty_entitlements = true;
};

struct LoadedCodeResult {
  bool ok = false;
  std::string reason;
  bool guest_created = false;
  bool code_valid = false;
  bool requirement_matched = false;
  bool adhoc = false;
  bool certificate_present = false;
  bool hardened_runtime = false;
  bool leaf_matched = false;
  bool identifier_matched = false;
  bool entitlements_empty = true;
  bool cdhash_matched = false;
  std::string cdhash_hex;
  std::string identifier;
  std::string leaf_sha256;
  std::string designated_requirement;
  uint32_t flags = 0;
};

// spawn 之后按实际 pid 读取内核/ Security 身份，确认加载的是固定签名 Node，
// 而不是只在 spawn 前按路径校验一次。
LoadedCodeResult verify_loaded_code_for_pid(pid_t pid, const LoadedCodeExpectation& expected);

}  // namespace zody::cua::round11
