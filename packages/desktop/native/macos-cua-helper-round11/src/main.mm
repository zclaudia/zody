#include <signal.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "machine_lease.h"
#include "orchestrator.h"
#include "r11_pins.h"
#include "r11_self_identity.h"

namespace {

constexpr const char* kVersion = "0.2.0-round11-peer-authority";

std::string json_escape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (char character : value) {
    switch (character) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        out.push_back(character);
        break;
    }
  }
  return out;
}

void print_usage() {
  std::printf(
      "usage: macos-cua-helper-round11 [--preflight|--run-once|--helper] [options]\n"
      "  --preflight\n"
      "  --run-once --window-id <id> --output <png> [--pid <pid>] [--layer <n>] [--x <n>] "
      "[--y <n>] [--width <n>] [--height <n>]\n"
      "  --helper --peer <socket> --window-id <id> [target options]\n"
      "No model execution, no finalFrame publication. Unsigned builds are rejected.\n");
}

bool parse_u32(const char* text, uint32_t& value) {
  if (text == nullptr || *text == '\0') return false;
  char* end = nullptr;
  const unsigned long parsed = std::strtoul(text, &end, 10);
  if (end == nullptr || *end != '\0' || parsed == 0 || parsed > 0xffffffffUL) return false;
  value = static_cast<uint32_t>(parsed);
  return true;
}

bool parse_i32(const char* text, int32_t& value) {
  if (text == nullptr || *text == '\0') return false;
  char* end = nullptr;
  const long parsed = std::strtol(text, &end, 10);
  if (end == nullptr || *end != '\0' || parsed < -2147483648L || parsed > 2147483647L) {
    return false;
  }
  value = static_cast<int32_t>(parsed);
  return true;
}

bool parse_double(const char* text, double& value) {
  if (text == nullptr || *text == '\0') return false;
  char* end = nullptr;
  value = std::strtod(text, &end);
  return end != nullptr && *end == '\0';
}

int run_preflight() {
  const zody::cua::round11::PinnedIdentity pinned = zody::cua::round11::pinned_identity();
  const zody::cua::round11::SelfPreflight report =
      zody::cua::round11::evaluate_self_preflight(pinned);
  const std::string lease_path = zody::cua::round11::machine_lease_path();
  std::printf(
      "{"
      "\"status\":\"%s\","
      "\"reason\":\"%s\","
      "\"captureEntry\":false,"
      "\"leasePath\":\"%s\","
      "\"signature\":{"
      "\"pinConfigured\":%s,"
      "\"codeCreated\":%s,"
      "\"codeValid\":%s,"
      "\"staticCodeCreated\":%s,"
      "\"resourceSealValid\":%s,"
      "\"signingInformationAvailable\":%s,"
      "\"adhoc\":%s,"
      "\"certificatePresent\":%s,"
      "\"hardenedRuntime\":%s,"
      "\"leafPinMatched\":%s,"
      "\"designatedRequirementMatched\":%s,"
      "\"identifierMatched\":%s,"
      "\"entitlementsPresent\":%s,"
      "\"forbiddenEntitlementsPresent\":%s,"
      "\"entitlementsEmpty\":%s,"
      "\"identifier\":\"%s\","
      "\"leafSha256\":\"%s\","
      "\"designatedRequirement\":\"%s\""
      "}"
      "}\n",
      report.ok ? "pass" : "blocked", json_escape(report.reason).c_str(),
      json_escape(lease_path).c_str(), report.pin_configured ? "true" : "false",
      report.code_created ? "true" : "false", report.code_valid ? "true" : "false",
      report.static_code_created ? "true" : "false",
      report.resource_seal_valid ? "true" : "false",
      report.signing_information_available ? "true" : "false",
      report.adhoc ? "true" : "false", report.certificate_present ? "true" : "false",
      report.hardened_runtime ? "true" : "false",
      report.leaf_pin_matched ? "true" : "false",
      report.designated_requirement_matched ? "true" : "false",
      report.identifier_matched ? "true" : "false",
      report.entitlements_present ? "true" : "false",
      report.forbidden_entitlements_present ? "true" : "false",
      report.entitlements_empty ? "true" : "false",
      json_escape(report.identifier).c_str(), json_escape(report.leaf_sha256).c_str(),
      json_escape(report.designated_requirement).c_str());
  return report.ok ? 0 : 3;
}

}  // namespace

int main(int argc, char** argv) {
  // Node 提前退出时 stdin pipe 的写入不能升级成 SIGPIPE 终止 Helper。
  (void)signal(SIGPIPE, SIG_IGN);
  if (argc == 2 && (std::strcmp(argv[1], "--help") == 0 || std::strcmp(argv[1], "-h") == 0)) {
    print_usage();
    return 0;
  }
  if (argc == 2 && std::strcmp(argv[1], "--version") == 0) {
    std::printf("%s\n", kVersion);
    return 0;
  }
  if (argc == 1 || (argc == 2 && std::strcmp(argv[1], "--preflight") == 0)) {
    return run_preflight();
  }

  bool run_once = false;
  bool helper = false;
  std::string peer_socket;
  zody::cua::round11::WindowTarget target;
  for (int index = 1; index < argc; index += 1) {
    const std::string argument = argv[index];
    if (argument == "--run-once") {
      run_once = true;
      continue;
    }
    if (argument == "--helper") {
      helper = true;
      continue;
    }
    const bool needs_value = argument == "--peer" || argument == "--window-id" ||
                             argument == "--output" || argument == "--pid" || argument == "--layer" ||
                             argument == "--x" || argument == "--y" || argument == "--width" ||
                             argument == "--height";
    if (!needs_value || index + 1 >= argc) {
      std::fprintf(stderr, "error: unsupported or incomplete argument\n");
      print_usage();
      return 2;
    }
    const char* value = argv[++index];
    bool valid = true;
    if (argument == "--peer") {
      peer_socket = value;
    } else if (argument == "--output") {
      target.output_path = value;
    } else if (argument == "--window-id") {
      valid = parse_u32(value, target.window_id);
    } else if (argument == "--pid") {
      valid = parse_i32(value, target.pid);
    } else if (argument == "--layer") {
      valid = parse_i32(value, target.layer);
    } else if (argument == "--x") {
      valid = parse_double(value, target.x);
    } else if (argument == "--y") {
      valid = parse_double(value, target.y);
    } else if (argument == "--width") {
      valid = parse_double(value, target.width);
    } else if (argument == "--height") {
      valid = parse_double(value, target.height);
    }
    if (!valid) {
      std::fprintf(stderr, "error: invalid argument value\n");
      return 2;
    }
  }
  if (run_once == helper) {
    std::fprintf(stderr, "error: choose exactly one of --run-once or --helper\n");
    print_usage();
    return 2;
  }

  std::string status;
  std::string reason;
  const int code = helper ? zody::cua::round11::run_helper(peer_socket, target, status, reason)
                          : zody::cua::round11::run_once(target, status, reason);
  std::printf("{\"status\":\"%s\",\"reason\":\"%s\",\"captureEntry\":%s}\n",
              json_escape(status).c_str(), json_escape(reason).c_str(),
              status == "pass" ? "true" : "false");
  return code;
}
