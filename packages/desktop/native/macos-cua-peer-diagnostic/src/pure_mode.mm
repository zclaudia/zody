#include <string>
#include <vector>

#include "cli_common.h"
#include "policy.h"
#include "pure_policy.h"
#include "report.h"

int run_pure_policy_check(const std::vector<std::string>& args) {
  Options options;
  std::string error;
  if (!parse_options(args, 2, options, error) ||
      options.flags.count("--pure-test-only") == 0 ||
      !only_options(options, {"--profile", "--facts"}, error, {"--pure-test-only"})) {
    emit_blocked_report("pure-policy-check", "pure-test-only-required",
                        {"--pure-test-only with --profile and --facts is required"});
    return 2;
  }
  std::string profile_path;
  std::string facts_path;
  if (!required_option(options, "--profile", profile_path, error) ||
      !required_option(options, "--facts", facts_path, error)) {
    emit_blocked_report("pure-policy-check", "pure-policy-input-missing", {error});
    return 2;
  }
  const PurePolicyValidation validation = load_pure_policy_inputs(profile_path, facts_path);
  if (!validation.ok) {
    emit_blocked_report("pure-policy-check", "pure-policy-input-invalid", validation.errors);
    return 2;
  }
  const PolicyDecision decision = evaluate_policy(validation.profile, validation.facts);
  emit_synthetic_report(validation.profile, validation.facts, decision);
  return 0;
}
