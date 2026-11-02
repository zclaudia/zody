#include "cli_common.h"

#include <cerrno>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <string>

void print_usage() {
  std::printf(
      "zody-cua-peer-diagnostic (diagnostic-only)\n\n"
      "Modes:\n"
      "  serve --workdir <dir> (--profile <local-profile.json> | --calibration-profile <node-profile.json>)\n"
      "        --expect-pid <pid> --expect-uid <uid> [--timeout-ms <ms>]\n"
      "  connect --socket <path> [--timeout-ms <ms>]\n"
      "  connect-replace --socket <path> [--hold-ms <ms>] [--timeout-ms <ms>]\n"
      "  connect-partial --socket <path> --declared-bytes <n> --send-bytes <n> [--hold-ms <ms>]\n"
      "  hold-socket --socket <path> [--hold-ms <ms>]\n"
      "  pure-policy-check --pure-test-only --profile <local-profile.json> --facts <facts.json>\n"
      "  --help | --version\n\n"
      "This executable only diagnoses peer identity. It never issues a grant, never proves native\n"
      "capability, and is not consumed by the product runtime.\n");
}

bool parse_options(const std::vector<std::string>& args, size_t start, Options& options,
                   std::string& error) {
  for (size_t index = start; index < args.size(); ++index) {
    const std::string& argument = args[index];
    if (argument == "--pure-test-only") {
      if (options.flags.count(argument) != 0) {
        error = "duplicate --pure-test-only";
        return false;
      }
      options.flags.insert(argument);
      continue;
    }
    if (argument.rfind("--", 0) != 0) {
      error = "unexpected positional argument";
      return false;
    }
    if (index + 1 >= args.size()) {
      error = "missing value for " + argument;
      return false;
    }
    if (options.values.count(argument) != 0) {
      error = "duplicate option " + argument;
      return false;
    }
    options.values[argument] = args[++index];
  }
  return true;
}

bool only_options(const Options& options, const std::set<std::string>& allowed,
                  std::string& error, const std::set<std::string>& allowed_flags) {
  for (const auto& [key, value] : options.values) {
    (void)value;
    if (allowed.count(key) == 0) {
      error = "unknown option " + key;
      return false;
    }
  }
  for (const std::string& flag : options.flags) {
    if (allowed_flags.count(flag) == 0) {
      error = "unexpected flag in this mode";
      return false;
    }
  }
  return true;
}

bool parse_integer(const std::string& value, long long minimum, long long maximum,
                   long long& output) {
  if (value.empty()) {
    return false;
  }
  char* end = nullptr;
  errno = 0;
  const long long parsed = std::strtoll(value.c_str(), &end, 10);
  if (errno != 0 || end == value.c_str() || *end != '\0' || parsed < minimum ||
      parsed > maximum) {
    return false;
  }
  output = parsed;
  return true;
}

bool option_int(const Options& options, const std::string& key, long long fallback,
                long long minimum, long long maximum, long long& value, std::string& error) {
  const auto iterator = options.values.find(key);
  if (iterator == options.values.end()) {
    value = fallback;
    return true;
  }
  if (!parse_integer(iterator->second, minimum, maximum, value)) {
    error = "invalid value for " + key;
    return false;
  }
  return true;
}

bool required_option(const Options& options, const std::string& key, std::string& value,
                     std::string& error) {
  const auto iterator = options.values.find(key);
  if (iterator == options.values.end() || iterator->second.empty()) {
    error = "missing required option " + key;
    return false;
  }
  value = iterator->second;
  return true;
}

void emit_raw_json(const std::string& json) {
  std::fputs(json.c_str(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

void emit_ready(const char* status, const SocketOwnership& ownership, unsigned long long hold_ms) {
  char buffer[512];
  std::snprintf(buffer, sizeof(buffer),
                "{\"role\":\"client\",\"status\":\"%s\",\"inode\":%llu,\"device\":%llu,"
                "\"holdMs\":%llu,\"diagnosticOnly\":true,\"grant\":false,"
                "\"nativeCapabilityProven\":false,\"runtimeConsumable\":false,\"productHook\":false}",
                status, static_cast<unsigned long long>(ownership.inode),
                static_cast<unsigned long long>(ownership.device), hold_ms);
  emit_raw_json(buffer);
}
