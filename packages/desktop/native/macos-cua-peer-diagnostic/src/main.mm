#include <cstdio>
#include <string>
#include <vector>

#include "cli_common.h"

int main(int argc, char** argv) {
  std::vector<std::string> args;
  args.reserve(static_cast<size_t>(argc));
  for (int index = 0; index < argc; ++index) {
    args.emplace_back(argv[index]);
  }
  if (args.size() == 2 && (args[1] == "--help" || args[1] == "-h")) {
    print_usage();
    return 0;
  }
  if (args.size() == 2 && args[1] == "--version") {
    std::printf("%s\n", kVersion);
    return 0;
  }
  if (args.size() < 2) {
    print_usage();
    return 2;
  }
  const std::string& mode = args[1];
  if (mode == "serve") {
    return run_serve(args);
  }
  if (mode == "connect") {
    return run_connect(args, false, false);
  }
  if (mode == "connect-replace") {
    return run_connect(args, true, false);
  }
  if (mode == "connect-partial") {
    return run_connect(args, false, true);
  }
  if (mode == "hold-socket") {
    return run_hold_socket(args);
  }
  if (mode == "pure-policy-check") {
    return run_pure_policy_check(args);
  }
  std::fprintf(stderr, "error: unknown mode\n");
  print_usage();
  return 2;
}
