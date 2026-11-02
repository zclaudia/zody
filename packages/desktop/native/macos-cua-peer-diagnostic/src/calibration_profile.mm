#include "calibration_profile.h"

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
const std::set<std::string> kFields = {
    "schemaVersion",       "kind",                 "calibrationOnly",
    "identifier",          "leafCertificateSha256", "certificateSha1",
    "designatedRequirement", "executableSha256",     "architectures",
    "minimumMacOSVersion", "entitlements",
};

std::string utf8(NSString* value) {
  return value == nil ? "" : std::string([value UTF8String]);
}

std::string to_lower(std::string value) {
  for (char& character : value) {
    if (character >= 'A' && character <= 'Z') {
      character = static_cast<char>(character - 'A' + 'a');
    }
  }
  return value;
}

void add_error(CalibrationValidation& validation, const std::string& error) {
  if (validation.errors.size() < 16) {
    validation.errors.push_back(error);
  }
}

bool read_string(NSDictionary* dictionary, const char* key, std::string& output,
                 CalibrationValidation& validation) {
  id value = dictionary[[NSString stringWithUTF8String:key]];
  if (![value isKindOfClass:[NSString class]]) {
    add_error(validation, std::string(key) + " must be a string");
    return false;
  }
  output = utf8(static_cast<NSString*>(value));
  if (output.empty() || output.find('\0') != std::string::npos ||
      output.find('\n') != std::string::npos || output.find('\r') != std::string::npos) {
    add_error(validation, std::string(key) + " must be non-empty and contain no NUL/newline");
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

std::string read_file(const std::string& path, std::string& error) {
  const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    error = std::string("cannot open calibration profile: ") + std::strerror(errno);
    return "";
  }
  struct stat info {};
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) ||
      static_cast<size_t>(info.st_size) > kMaxProfileBytes) {
    error = "calibration profile must be a bounded regular file";
    close(fd);
    return "";
  }
  if (info.st_uid != geteuid()) {
    error = "calibration profile must be owned by the current effective user";
    close(fd);
    return "";
  }
  if ((info.st_mode & 022) != 0) {
    error = "calibration profile must not be group- or world-writable";
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
      error = std::string("cannot read calibration profile: ") + std::strerror(errno);
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

}  // namespace

CalibrationValidation load_and_validate_calibration_profile(const std::string& path) {
  CalibrationValidation validation;
  std::string read_error;
  const std::string text = read_file(path, read_error);
  if (!read_error.empty()) {
    add_error(validation, read_error);
    return validation;
  }
  NSError* json_error = nil;
  NSData* data = [NSData dataWithBytes:text.data() length:text.size()];
  id root = [NSJSONSerialization JSONObjectWithData:data options:0 error:&json_error];
  if (root == nil || json_error != nil || ![root isKindOfClass:[NSDictionary class]]) {
    add_error(validation, "calibration profile root must be a JSON object");
    return validation;
  }
  NSDictionary* dictionary = static_cast<NSDictionary*>(root);
  if (dictionary.count != kFields.size()) {
    add_error(validation, "calibration profile must contain exactly the 11 known fields");
  }
  for (id key in dictionary) {
    if (![key isKindOfClass:[NSString class]] || kFields.count(utf8(key)) == 0) {
      add_error(validation, "calibration profile contains an unknown field");
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
  id calibration_only = dictionary[@"calibrationOnly"];
  if (![calibration_only isKindOfClass:[NSNumber class]] || ![calibration_only boolValue]) {
    add_error(validation, "calibrationOnly must be true");
  }
  std::string kind;
  std::string identifier;
  std::string minimum_macos;
  if (read_string(dictionary, "kind", kind, validation) &&
      kind != "zody-cua-node-signature-calibration-profile") {
    add_error(validation, "kind must be zody-cua-node-signature-calibration-profile");
  }
  if (read_string(dictionary, "identifier", identifier, validation) && identifier != "node") {
    add_error(validation, "calibration identifier must be node");
  }

  ExpectedProfile& profile = validation.profile;
  profile.calibration_only = true;
  profile.bundle_id = identifier;
  read_string(dictionary, "leafCertificateSha256", profile.leaf_certificate_sha256, validation);
  std::string certificate_sha1;
  read_string(dictionary, "certificateSha1", certificate_sha1, validation);
  read_string(dictionary, "designatedRequirement", profile.designated_requirement, validation);
  read_string(dictionary, "executableSha256", profile.executable_sha256, validation);
  read_string(dictionary, "minimumMacOSVersion", minimum_macos, validation);
  profile.minimum_macos_version = minimum_macos;

  static const std::regex sha256_pattern(R"(^[0-9a-fA-F]{64}$)");
  static const std::regex sha1_pattern(R"(^[0-9a-fA-F]{40}$)");
  static const std::regex version_pattern(R"(^[0-9]+(\.[0-9]+){0,2}$)");
  if (!std::regex_match(profile.leaf_certificate_sha256, sha256_pattern)) {
    add_error(validation, "leafCertificateSha256 must be 64 hexadecimal characters");
  }
  if (!std::regex_match(profile.executable_sha256, sha256_pattern)) {
    add_error(validation, "executableSha256 must be 64 hexadecimal characters");
  }
  if (!std::regex_match(certificate_sha1, sha1_pattern)) {
    add_error(validation, "certificateSha1 must be 40 hexadecimal characters");
  }
  profile.leaf_certificate_sha256 = to_lower(profile.leaf_certificate_sha256);
  profile.executable_sha256 = to_lower(profile.executable_sha256);
  certificate_sha1 = to_lower(certificate_sha1);
  if (!std::regex_match(minimum_macos, version_pattern)) {
    add_error(validation, "minimumMacOSVersion must be a numeric version");
  }
  std::string requirement_identifier;
  std::string requirement_sha1;
  if (!parse_narrow_requirement(profile.designated_requirement, requirement_identifier,
                                requirement_sha1)) {
    add_error(validation, "designatedRequirement must use the narrow identifier/leaf form");
  } else if (requirement_identifier != "node" ||
             requirement_sha1 != certificate_sha1) {
    add_error(validation, "designatedRequirement must pin identifier node and certificateSha1");
  }
  profile.certificate_sha1 = requirement_sha1;

  id architectures = dictionary[@"architectures"];
  if (![architectures isKindOfClass:[NSArray class]]) {
    add_error(validation, "architectures must be an array");
  } else {
    NSArray* array = static_cast<NSArray*>(architectures);
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
      has_arm64 = has_arm64 || architecture == "arm64";
      profile.architectures.push_back(architecture);
    }
    if (!has_arm64) {
      add_error(validation, "calibration architectures must include arm64");
    }
  }
  id entitlements = dictionary[@"entitlements"];
  if (![entitlements isKindOfClass:[NSDictionary class]]) {
    add_error(validation, "entitlements must be an object");
  } else {
    profile.entitlements_json = canonical_json(entitlements);
    if (profile.entitlements_json.empty()) {
      add_error(validation, "entitlements must be JSON-serializable");
    }
  }

  validation.ok = validation.errors.empty();
  profile.usable = validation.ok;
  return validation;
}
