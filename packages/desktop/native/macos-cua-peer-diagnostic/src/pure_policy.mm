#include "pure_policy.h"

#import <Foundation/Foundation.h>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <regex>
#include <set>
#include <string>

namespace {

constexpr size_t kMaxFactsBytes = 64 * 1024;
const std::set<std::string> kFactFields = {
    "identifier", "leafCertificateSha256", "leafCertificateSha1", "designatedRequirement",
    "adhoc", "certificatePresent", "codeValid", "requirementMatched",
};

void add_error(PurePolicyValidation& validation, const std::string& error) {
  validation.errors.push_back(error);
}

std::string utf8(NSString* value) {
  return value == nil ? "" : std::string([value UTF8String]);
}

std::string read_file(const std::string& path, std::string& error) {
  const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    error = std::string("cannot open facts file: ") + std::strerror(errno);
    return "";
  }
  struct stat info {};
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) ||
      static_cast<size_t>(info.st_size) > kMaxFactsBytes) {
    error = "facts file must be a bounded regular file";
    close(fd);
    return "";
  }
  std::string text(static_cast<size_t>(info.st_size), '\0');
  size_t offset = 0;
  while (offset < text.size()) {
    const ssize_t count = read(fd, text.data() + offset, text.size() - offset);
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      error = std::string("cannot read facts file: ") + std::strerror(errno);
      close(fd);
      return "";
    }
    if (count == 0) {
      break;
    }
    offset += static_cast<size_t>(count);
  }
  close(fd);
  text.resize(offset);
  return text;
}

bool read_string(NSDictionary* dictionary, const char* key, std::string& output,
                 PurePolicyValidation& validation) {
  id value = dictionary[[NSString stringWithUTF8String:key]];
  if (![value isKindOfClass:[NSString class]]) {
    add_error(validation, std::string(key) + " must be a string");
    return false;
  }
  output = utf8(static_cast<NSString*>(value));
  if (output.empty()) {
    add_error(validation, std::string(key) + " must not be empty");
    return false;
  }
  return true;
}

bool read_bool(NSDictionary* dictionary, const char* key, bool& output,
               PurePolicyValidation& validation) {
  id value = dictionary[[NSString stringWithUTF8String:key]];
  if (![value isKindOfClass:[NSNumber class]] ||
      CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID()) {
    add_error(validation, std::string(key) + " must be a boolean");
    return false;
  }
  output = CFBooleanGetValue((__bridge CFBooleanRef)value);
  return true;
}

}  // namespace

PurePolicyValidation load_pure_policy_inputs(const std::string& profile_path,
                                             const std::string& facts_path) {
  PurePolicyValidation validation;
  ProfileValidation profile_validation = load_and_validate_profile(profile_path);
  if (!profile_validation.ok) {
    validation.errors = profile_validation.errors;
    return validation;
  }
  validation.profile = profile_validation.profile;

  std::string read_error;
  const std::string text = read_file(facts_path, read_error);
  if (!read_error.empty()) {
    add_error(validation, read_error);
    return validation;
  }
  NSError* json_error = nil;
  NSData* data = [NSData dataWithBytes:text.data() length:text.size()];
  id root = [NSJSONSerialization JSONObjectWithData:data options:0 error:&json_error];
  if (root == nil || json_error != nil || ![root isKindOfClass:[NSDictionary class]]) {
    add_error(validation, "facts root must be a JSON object");
    return validation;
  }
  NSDictionary* dictionary = static_cast<NSDictionary*>(root);
  if (dictionary.count != kFactFields.size()) {
    add_error(validation, "facts must contain exactly the eight known fields");
  }
  for (id key in dictionary) {
    if (![key isKindOfClass:[NSString class]] || kFactFields.count(utf8(key)) == 0) {
      add_error(validation, "facts contain an unknown field");
      break;
    }
  }
  PolicyFacts& facts = validation.facts;
  read_string(dictionary, "identifier", facts.identifier, validation);
  read_string(dictionary, "leafCertificateSha256", facts.leaf_sha256, validation);
  read_string(dictionary, "leafCertificateSha1", facts.leaf_sha1, validation);
  read_string(dictionary, "designatedRequirement", facts.designated_requirement, validation);
  read_bool(dictionary, "adhoc", facts.adhoc, validation);
  read_bool(dictionary, "certificatePresent", facts.certificate_present, validation);
  read_bool(dictionary, "codeValid", facts.code_valid, validation);
  read_bool(dictionary, "requirementMatched", facts.requirement_matched, validation);

  static const std::regex sha256_pattern(R"(^[0-9a-fA-F]{64}$)");
  static const std::regex sha1_pattern(R"(^[0-9a-fA-F]{40}$)");
  if (!std::regex_match(facts.leaf_sha256, sha256_pattern)) {
    add_error(validation, "leafCertificateSha256 must be 64 hexadecimal characters");
  }
  if (!std::regex_match(facts.leaf_sha1, sha1_pattern)) {
    add_error(validation, "leafCertificateSha1 must be 40 hexadecimal characters");
  }
  std::string identifier;
  std::string certificate_sha1;
  if (!parse_narrow_requirement(facts.designated_requirement, identifier, certificate_sha1)) {
    add_error(validation, "designatedRequirement must use the narrow identifier/leaf form");
  }
  facts.synthetic = true;
  facts.token_captured = false;
  facts.security_executed = false;
  facts.guest_created = false;
  facts.static_artifact_performed = false;
  facts.static_artifact_matched = false;
  validation.ok = validation.errors.empty();
  return validation;
}
