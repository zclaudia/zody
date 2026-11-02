#pragma once

#include <map>
#include <set>
#include <string>
#include <vector>

#include "peer_socket.h"

inline constexpr const char* kVersion = "zody-cua-peer-diagnostic 0.1.0 (diagnostic-only)";
inline constexpr const char* kRequest =
    "{\"kind\":\"zody-cua-peer-identity-request\",\"schemaVersion\":1}";
inline constexpr int kDefaultTimeoutMs = 5000;
inline constexpr size_t kMaxRequestBytes = 4096;
inline constexpr size_t kMaxResponseBytes = 64 * 1024;

struct Options {
  std::map<std::string, std::string> values;
  std::set<std::string> flags;
};

void print_usage();
bool parse_options(const std::vector<std::string>& args, size_t start, Options& options,
                   std::string& error);
bool only_options(const Options& options, const std::set<std::string>& allowed,
                  std::string& error, const std::set<std::string>& allowed_flags = {});
bool parse_integer(const std::string& value, long long minimum, long long maximum,
                   long long& output);
bool option_int(const Options& options, const std::string& key, long long fallback,
                long long minimum, long long maximum, long long& value, std::string& error);
bool required_option(const Options& options, const std::string& key, std::string& value,
                     std::string& error);
void emit_raw_json(const std::string& json);
void emit_ready(const char* status, const SocketOwnership& ownership, unsigned long long hold_ms);

int run_serve(const std::vector<std::string>& args);
int run_connect(const std::vector<std::string>& args, bool replace, bool partial);
int run_hold_socket(const std::vector<std::string>& args);
int run_pure_policy_check(const std::vector<std::string>& args);
