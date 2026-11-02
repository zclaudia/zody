#include "profile.h"

#import <Foundation/Foundation.h>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <regex>
#include <set>
#include <string>
#include <vector>

namespace {

constexpr size_t kMaxProfileBytes = 1024 * 1024;
constexpr size_t kMaxErrors = 16;
const std::set<std::string> kFields = {
    "schemaVersion",       "profile",          "bundleId",
    "executableName",      "bundleShortVersion", "bundleVersion",
    "architectures",       "minimumMacOSVersion", "leafCertificateSha256",
    "designatedRequirement", "executableSha256", "entitlements",
};
const std::set<std::string> kForbiddenEntitlements = {
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.cs.allow-dyld-environment-variables",
};

std::string trim(const std::string& value) {
  const auto begin = value.find_first_not_of(" \t\r\n");
  if (begin == std::string::npos) {
    return "";
  }
  const auto end = value.find_last_not_of(" \t\r\n");
  return value.substr(begin, end - begin + 1);
}

std::string to_lower(std::string value) {
  for (char& character : value) {
    if (character >= 'A' && character <= 'Z') {
      character = static_cast<char>(character - 'A' + 'a');
    }
  }
  return value;
}

bool has_control_characters(const std::string& value) {
  return value.find('\0') != std::string::npos || value.find('\n') != std::string::npos ||
         value.find('\r') != std::string::npos;
}

void add_error(ProfileValidation& validation, const std::string& error) {
  if (validation.errors.size() < kMaxErrors) {
    validation.errors.push_back(error);
  }
}

bool is_numeric_version(const std::string& value, size_t minimum_parts) {
  static const std::regex pattern(R"(^[0-9]+(\.[0-9]+){0,2}$)");
  if (!std::regex_match(value, pattern)) {
    return false;
  }
  size_t parts = 1;
  for (char character : value) {
    if (character == '.') {
      ++parts;
    }
  }
  return parts >= minimum_parts;
}

int compare_versions(const std::string& left, const std::string& right) {
  std::vector<long long> left_parts;
  std::vector<long long> right_parts;
  auto split = [](const std::string& value, std::vector<long long>& output) {
    size_t start = 0;
    while (start <= value.size()) {
      const size_t dot = value.find('.', start);
      const std::string part = value.substr(start, dot == std::string::npos ? std::string::npos : dot - start);
      output.push_back(std::strtoll(part.c_str(), nullptr, 10));
      if (dot == std::string::npos) {
        break;
      }
      start = dot + 1;
    }
  };
  split(left, left_parts);
  split(right, right_parts);
  const size_t length = std::max(left_parts.size(), right_parts.size());
  for (size_t index = 0; index < length; ++index) {
    const long long left_value = index < left_parts.size() ? left_parts[index] : 0;
    const long long right_value = index < right_parts.size() ? right_parts[index] : 0;
    if (left_value != right_value) {
      return left_value < right_value ? -1 : 1;
    }
  }
  return 0;
}

std::string utf8(NSString* value) {
  if (value == nil) {
    return "";
  }
  const char* bytes = [value UTF8String];
  return bytes == nullptr ? "" : std::string(bytes);
}

bool read_string(NSDictionary* dictionary, const char* key, std::string& output,
                 ProfileValidation& validation) {
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
  if (has_control_characters(output)) {
    add_error(validation, std::string(key) + " must not contain NUL or newlines");
    return false;
  }
  return true;
}

std::string canonical_json(id value) {
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:value
                                                 options:NSJSONWritingSortedKeys
                                                   error:&error];
  if (data == nil || error != nil) {
    return "";
  }
  NSString* text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  return utf8(text);
}

}  // namespace

bool parse_narrow_requirement(const std::string& text, std::string& identifier,
                              std::string& certificate_sha1) {
  static const std::regex pattern(
      R"RE(^identifier "([^"]+)" and certificate leaf = H"([0-9a-fA-F]{40})"$)RE");
  std::smatch match;
  const std::string trimmed = trim(text);
  if (!std::regex_match(trimmed, match, pattern)) {
    return false;
  }
  identifier = match[1].str();
  certificate_sha1 = to_lower(match[2].str());
  return !identifier.empty();
}

ProfileValidation validate_profile_json(const std::string& text) {
  ProfileValidation validation;
  NSError* json_error = nil;
  NSData* data = [NSData dataWithBytes:text.data() length:text.size()];
  id root = [NSJSONSerialization JSONObjectWithData:data options:0 error:&json_error];
  if (root == nil || json_error != nil || ![root isKindOfClass:[NSDictionary class]]) {
    add_error(validation, "profile root must be a JSON object");
    return validation;
  }
  NSDictionary* dictionary = static_cast<NSDictionary*>(root);
  if (dictionary.count != kFields.size()) {
    add_error(validation, "profile must contain exactly the 12 known fields");
  }
  for (id key in dictionary) {
    if (![key isKindOfClass:[NSString class]] || kFields.count(utf8(key)) == 0) {
      add_error(validation, "profile contains an unknown field");
      break;
    }
  }

  id schema = dictionary[@"schemaVersion"];
  bool schema_valid = false;
  if ([schema isKindOfClass:[NSNumber class]] &&
      CFGetTypeID((__bridge CFTypeRef)schema) == CFNumberGetTypeID() &&
      !CFNumberIsFloatType((__bridge CFNumberRef)schema)) {
    long long schema_value = 0;
    schema_valid = CFNumberGetValue((__bridge CFNumberRef)schema, kCFNumberLongLongType,
                                    &schema_value) &&
                   schema_value == 1;
  }
  if (!schema_valid) {
    add_error(validation, "schemaVersion must be 1");
  }
  std::string profile_kind;
  if (read_string(dictionary, "profile", profile_kind, validation) &&
      profile_kind != "local-self-signed") {
    add_error(validation, "profile must be local-self-signed");
  }

  ExpectedProfile& profile = validation.profile;
  read_string(dictionary, "bundleId", profile.bundle_id, validation);
  read_string(dictionary, "executableName", profile.executable_name, validation);
  read_string(dictionary, "leafCertificateSha256", profile.leaf_certificate_sha256, validation);
  read_string(dictionary, "designatedRequirement", profile.designated_requirement, validation);
  read_string(dictionary, "executableSha256", profile.executable_sha256, validation);
  read_string(dictionary, "minimumMacOSVersion", profile.minimum_macos_version, validation);
  std::string short_version;
  std::string bundle_version;
  read_string(dictionary, "bundleShortVersion", short_version, validation);
  read_string(dictionary, "bundleVersion", bundle_version, validation);

  static const std::regex bundle_pattern(R"(^[A-Za-z0-9][A-Za-z0-9.-]*$)");
  if (!profile.bundle_id.empty()) {
    if (!std::regex_match(profile.bundle_id, bundle_pattern)) {
      add_error(validation, "bundleId must be a reverse-DNS style identifier");
    }
    if (to_lower(profile.bundle_id).find("dev.zcode") != std::string::npos) {
      add_error(validation, "bundleId must not reuse the historical dev.zcode identity");
    }
  }
  if (!profile.executable_name.empty() &&
      (profile.executable_name == "." || profile.executable_name == ".." ||
       profile.executable_name.find('/') != std::string::npos ||
       profile.executable_name.find('\\') != std::string::npos)) {
    add_error(validation, "executableName must be a single path component");
  }
  if (!short_version.empty() && !is_numeric_version(short_version, 1)) {
    add_error(validation, "bundleShortVersion must be a dot-separated numeric version");
  }
  if (!bundle_version.empty() && !is_numeric_version(bundle_version, 1)) {
    add_error(validation, "bundleVersion must be a dot-separated numeric version");
  }
  if (!profile.minimum_macos_version.empty()) {
    if (!is_numeric_version(profile.minimum_macos_version, 2)) {
      add_error(validation, "minimumMacOSVersion must be a dot-separated numeric version");
    } else if (compare_versions(profile.minimum_macos_version, "14.2") < 0) {
      add_error(validation, "minimumMacOSVersion must be at least 14.2");
    }
  }

  static const std::regex sha_pattern(R"(^[0-9a-fA-F]{64}$)");
  if (!profile.leaf_certificate_sha256.empty() &&
      !std::regex_match(profile.leaf_certificate_sha256, sha_pattern)) {
    add_error(validation, "leafCertificateSha256 must be 64 hexadecimal characters");
  } else {
    profile.leaf_certificate_sha256 = to_lower(profile.leaf_certificate_sha256);
  }
  if (!profile.executable_sha256.empty() &&
      !std::regex_match(profile.executable_sha256, sha_pattern)) {
    add_error(validation, "executableSha256 must be 64 hexadecimal characters");
  } else {
    profile.executable_sha256 = to_lower(profile.executable_sha256);
  }

  std::string requirement_identifier;
  if (!profile.designated_requirement.empty()) {
    if (!parse_narrow_requirement(profile.designated_requirement, requirement_identifier,
                                  profile.certificate_sha1)) {
      add_error(validation,
                "designatedRequirement must be exactly identifier \"<bundleId>\" and "
                "certificate leaf = H\"<40-hex SHA-1>\"");
    } else if (!profile.bundle_id.empty() && requirement_identifier != profile.bundle_id) {
      add_error(validation, "designatedRequirement identifier must equal bundleId");
    }
  }

  id architectures = dictionary[@"architectures"];
  if (![architectures isKindOfClass:[NSArray class]]) {
    add_error(validation, "architectures must be an array");
  } else {
    NSArray* array = static_cast<NSArray*>(architectures);
    if (array.count == 0) {
      add_error(validation, "architectures must not be empty");
    }
    std::set<std::string> seen;
    bool has_arm64 = false;
    for (id entry in array) {
      if (![entry isKindOfClass:[NSString class]]) {
        add_error(validation, "architectures entries must be strings");
        continue;
      }
      const std::string architecture = utf8(entry);
      if (architecture != "arm64" && architecture != "arm64e" && architecture != "x86_64") {
        add_error(validation, "architectures entries must be arm64, arm64e or x86_64");
      }
      if (!seen.insert(architecture).second) {
        add_error(validation, "architectures must not contain duplicates");
      }
      has_arm64 = has_arm64 || architecture == "arm64";
      profile.architectures.push_back(architecture);
    }
    if (!has_arm64 && array.count > 0) {
      add_error(validation, "architectures must include arm64");
    }
  }

  id entitlements = dictionary[@"entitlements"];
  if (![entitlements isKindOfClass:[NSDictionary class]]) {
    add_error(validation, "entitlements must be an object");
  } else {
    NSDictionary* entitlement_dictionary = static_cast<NSDictionary*>(entitlements);
    for (NSString* key in entitlement_dictionary) {
      if (kForbiddenEntitlements.count(utf8(key)) != 0) {
        add_error(validation, "entitlements contain a forbidden key");
      }
    }
    profile.entitlements_json = canonical_json(entitlement_dictionary);
    if (profile.entitlements_json.empty()) {
      add_error(validation, "entitlements must be JSON-serializable");
    }
  }

  validation.ok = validation.errors.empty();
  profile.usable = validation.ok;
  return validation;
}

ProfileValidation load_and_validate_profile(const std::string& path) {
  ProfileValidation validation;
  const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    add_error(validation, std::string("cannot open pinned profile: ") + std::strerror(errno));
    return validation;
  }
  struct stat info {};
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode)) {
    add_error(validation, "pinned profile must be a regular file");
    close(fd);
    return validation;
  }
  if (info.st_uid != geteuid()) {
    add_error(validation, "pinned profile must be owned by the current effective user");
    close(fd);
    return validation;
  }
  if ((info.st_mode & 022) != 0) {
    add_error(validation, "pinned profile must not be group- or world-writable");
    close(fd);
    return validation;
  }
  if (static_cast<size_t>(info.st_size) > kMaxProfileBytes) {
    add_error(validation, "pinned profile exceeds the size limit");
    close(fd);
    return validation;
  }
  std::string text(static_cast<size_t>(info.st_size), '\0');
  size_t offset = 0;
  while (offset < text.size()) {
    const ssize_t read_count = read(fd, text.data() + offset, text.size() - offset);
    if (read_count < 0) {
      if (errno == EINTR) {
        continue;
      }
      add_error(validation, std::string("cannot read pinned profile: ") + std::strerror(errno));
      close(fd);
      return validation;
    }
    if (read_count == 0) {
      break;
    }
    offset += static_cast<size_t>(read_count);
  }
  close(fd);
  text.resize(offset);
  return validate_profile_json(text);
}
