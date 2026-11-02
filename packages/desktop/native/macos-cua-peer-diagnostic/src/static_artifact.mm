#include "static_artifact.h"

#import <CommonCrypto/CommonDigest.h>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <string>
#include <vector>

#include "macho_artifact.h"

namespace {

constexpr size_t kHashBufferBytes = 64 * 1024;

std::string sha256_file(const std::string& path, std::string& error) {
  const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    error = std::string("cannot open executable for hashing: ") + std::strerror(errno);
    return "";
  }
  struct stat info {};
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode)) {
    error = "executable for hashing is not a regular file";
    close(fd);
    return "";
  }
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  std::vector<uint8_t> buffer(kHashBufferBytes);
  while (true) {
    const ssize_t count = read(fd, buffer.data(), buffer.size());
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      error = std::string("cannot read executable for hashing: ") + std::strerror(errno);
      close(fd);
      return "";
    }
    if (count == 0) {
      break;
    }
    CC_SHA256_Update(&context, buffer.data(), static_cast<CC_LONG>(count));
  }
  close(fd);
  uint8_t digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &context);
  static const char* hex = "0123456789abcdef";
  std::string result;
  result.reserve(sizeof(digest) * 2);
  for (uint8_t byte : digest) {
    result.push_back(hex[(byte >> 4) & 0x0f]);
    result.push_back(hex[byte & 0x0f]);
  }
  return result;
}

std::string normalize_version(const std::string& value) {
  std::vector<long long> parts;
  size_t start = 0;
  while (start <= value.size()) {
    const size_t dot = value.find('.', start);
    const std::string part =
        value.substr(start, dot == std::string::npos ? std::string::npos : dot - start);
    parts.push_back(std::strtoll(part.c_str(), nullptr, 10));
    if (dot == std::string::npos) {
      break;
    }
    start = dot + 1;
  }
  while (parts.size() > 2 && parts.back() == 0) {
    parts.pop_back();
  }
  std::string result;
  for (size_t index = 0; index < parts.size(); ++index) {
    if (index > 0) {
      result += ".";
    }
    result += std::to_string(parts[index]);
  }
  return result;
}

bool same_string_set(std::vector<std::string> left, std::vector<std::string> right) {
  std::sort(left.begin(), left.end());
  std::sort(right.begin(), right.end());
  return left == right;
}

}  // namespace

StaticArtifactObservation inspect_static_artifact(
    const std::string& executable_path,
    const ExpectedProfile& profile,
    const std::string& actual_entitlements_json,
    bool entitlements_present) {
  StaticArtifactObservation observation;
  observation.executable_path = executable_path;
  observation.sha256_expected = profile.executable_sha256;
  observation.entitlements_expected_json = profile.entitlements_json;
  observation.entitlements_actual_json = entitlements_present ? actual_entitlements_json : "{}";
  observation.architectures_expected = profile.architectures;
  observation.minimum_macos_expected = profile.minimum_macos_version;

  if (executable_path.empty()) {
    observation.errors.push_back("executable path from static code is unavailable");
  } else {
    std::string hash_error;
    observation.sha256_actual = sha256_file(executable_path, hash_error);
    if (!hash_error.empty()) {
      observation.errors.push_back(hash_error);
    }
  }
  if (observation.sha256_actual.size() != observation.sha256_expected.size()) {
    observation.errors.push_back("executable SHA-256 was not computed");
  } else {
    observation.sha256_matched = observation.sha256_actual == observation.sha256_expected;
  }

  const MachOStaticFacts macho = inspect_macho(executable_path);
  if (!macho.ok) {
    observation.errors.push_back(macho.error.empty() ? "Mach-O inspection failed" : macho.error);
  } else {
    observation.architectures_actual = macho.architectures;
    observation.minimum_macos_actual = macho.minimum_macos;
    observation.architectures_matched =
        same_string_set(observation.architectures_expected, observation.architectures_actual);
    observation.minimum_macos_matched =
        normalize_version(observation.minimum_macos_expected) ==
        normalize_version(observation.minimum_macos_actual);
  }

  observation.entitlements_matched =
      observation.entitlements_actual_json == observation.entitlements_expected_json;
  if (!observation.entitlements_matched) {
    observation.errors.push_back("entitlements differ from pinned profile");
  }

  observation.all_performed = observation.sha256_actual.size() == 64 && macho.ok;
  observation.matched = observation.all_performed && observation.sha256_matched &&
                        observation.entitlements_matched && observation.architectures_matched &&
                        observation.minimum_macos_matched;
  return observation;
}
