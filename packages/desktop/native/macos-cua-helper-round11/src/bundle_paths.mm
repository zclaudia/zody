#include "bundle_paths.h"

#import <CommonCrypto/CommonDigest.h>

#include <fcntl.h>
#include <mach-o/dyld.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

namespace zody::cua::round11 {
namespace {

std::string dirname_of(const std::string& path) {
  const size_t slash = path.find_last_of('/');
  return slash == std::string::npos ? "." : path.substr(0, slash);
}

bool hash_fd(int fd, std::string& digest, std::string& error) {
  struct stat info {};
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode)) {
    error = "resource is not a regular file";
    return false;
  }
  if (info.st_uid != geteuid()) {
    error = "resource is not owned by the effective uid";
    return false;
  }
  if ((info.st_mode & 022) != 0) {
    error = "resource must not be group- or world-writable";
    return false;
  }
  if (lseek(fd, 0, SEEK_SET) != 0) {
    error = std::string("lseek failed: ") + std::strerror(errno);
    return false;
  }
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  uint8_t buffer[64 * 1024];
  while (true) {
    const ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count < 0) {
      if (errno == EINTR) continue;
      error = std::string("read failed: ") + std::strerror(errno);
      return false;
    }
    if (count == 0) break;
    CC_SHA256_Update(&context, buffer, static_cast<CC_LONG>(count));
  }
  if (lseek(fd, 0, SEEK_SET) != 0) {
    error = std::string("lseek failed: ") + std::strerror(errno);
    return false;
  }
  uint8_t raw[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(raw, &context);
  static const char* hex = "0123456789abcdef";
  digest.clear();
  digest.reserve(sizeof(raw) * 2);
  for (uint8_t byte : raw) {
    digest.push_back(hex[(byte >> 4) & 0x0f]);
    digest.push_back(hex[byte & 0x0f]);
  }
  return true;
}

}  // namespace

VerifiedResource::~VerifiedResource() { close(); }

VerifiedResource::VerifiedResource(VerifiedResource&& other) noexcept
    : fd(other.fd), sha256(std::move(other.sha256)) {
  other.fd = -1;
}

VerifiedResource& VerifiedResource::operator=(VerifiedResource&& other) noexcept {
  if (this != &other) {
    close();
    fd = other.fd;
    sha256 = std::move(other.sha256);
    other.fd = -1;
  }
  return *this;
}

void VerifiedResource::close() {
  if (fd >= 0) {
    ::close(fd);
    fd = -1;
  }
}

bool resolve_bundle_paths(BundlePaths& paths, std::string& error) {
  uint32_t size = 0;
  (void)_NSGetExecutablePath(nullptr, &size);
  std::vector<char> buffer(size + 1, '\0');
  if (_NSGetExecutablePath(buffer.data(), &size) != 0) {
    error = "cannot resolve helper executable path";
    return false;
  }
  paths.executable = buffer.data();
  const std::string macos_dir = dirname_of(paths.executable);
  paths.contents = dirname_of(macos_dir);
  paths.resources = paths.contents + "/Resources";
  paths.node = paths.resources + "/node";
  paths.authority_entry = paths.resources + "/authority-entry.mjs";
  return true;
}

bool open_verified_resource(const std::string& path, const std::string& expected_sha256,
                            VerifiedResource& resource, std::string& error) {
  resource.close();
  if (expected_sha256.empty()) {
    error = "resource-pin-missing";
    return false;
  }
  const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    error = path + ": open failed: " + std::strerror(errno);
    return false;
  }
  std::string digest;
  std::string hash_error;
  if (!hash_fd(fd, digest, hash_error)) {
    error = path + ": " + hash_error;
    ::close(fd);
    return false;
  }
  if (digest != expected_sha256) {
    error = path + ": SHA-256 does not match the compiled pin";
    ::close(fd);
    return false;
  }
  if (!verify_path_matches_fd(path, fd, error)) {
    ::close(fd);
    return false;
  }
  resource.fd = fd;
  resource.sha256 = digest;
  return true;
}

bool read_verified_snapshot(const std::string& path, const std::string& expected_sha256,
                            size_t max_bytes, std::string& bytes, std::string& error) {
  bytes.clear();
  if (expected_sha256.empty()) {
    error = "resource-pin-missing";
    return false;
  }
  const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    error = path + ": open failed: " + std::strerror(errno);
    return false;
  }
  struct stat info {};
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode)) {
    error = path + ": resource is not a regular file";
    close(fd);
    return false;
  }
  if (info.st_uid != geteuid() || (info.st_mode & 022) != 0) {
    error = path + ": resource ownership or mode is unsafe";
    close(fd);
    return false;
  }
  if (info.st_size <= 0 || static_cast<uint64_t>(info.st_size) > max_bytes) {
    error = path + ": resource size is outside the bound";
    close(fd);
    return false;
  }
  bytes.resize(static_cast<size_t>(info.st_size));
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t count = read(fd, bytes.data() + offset, bytes.size() - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      error = path + ": read failed: " + std::strerror(errno);
      close(fd);
      bytes.clear();
      return false;
    }
    if (count == 0) break;
    offset += static_cast<size_t>(count);
  }
  close(fd);
  if (offset != bytes.size()) {
    error = path + ": short read";
    bytes.clear();
    return false;
  }
  uint8_t digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(reinterpret_cast<const uint8_t*>(bytes.data()),
            static_cast<CC_LONG>(bytes.size()), digest);
  static const char* hex = "0123456789abcdef";
  std::string actual;
  actual.reserve(sizeof(digest) * 2);
  for (uint8_t byte : digest) {
    actual.push_back(hex[(byte >> 4) & 0x0f]);
    actual.push_back(hex[byte & 0x0f]);
  }
  if (actual != expected_sha256) {
    error = path + ": snapshot SHA-256 does not match the compiled pin";
    bytes.clear();
    return false;
  }
  return true;
}

bool verify_path_matches_fd(const std::string& path, int fd, std::string& error) {
  struct stat opened {};
  struct stat linked {};
  if (fstat(fd, &opened) != 0) {
    error = path + ": fstat failed: " + std::strerror(errno);
    return false;
  }
  if (lstat(path.c_str(), &linked) != 0) {
    error = path + ": lstat failed: " + std::strerror(errno);
    return false;
  }
  if (!S_ISREG(linked.st_mode) || linked.st_dev != opened.st_dev ||
      linked.st_ino != opened.st_ino) {
    error = path + ": path no longer matches the verified open file";
    return false;
  }
  return true;
}

}  // namespace zody::cua::round11
