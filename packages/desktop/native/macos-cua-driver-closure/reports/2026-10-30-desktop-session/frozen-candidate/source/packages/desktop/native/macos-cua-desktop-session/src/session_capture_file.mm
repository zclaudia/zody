#include "session_capture_file.h"

#import <CommonCrypto/CommonDigest.h>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <string>

namespace zody::cua::desktop_session {
namespace {

bool verify_root(const std::string& capture_root, std::string& error) {
  struct stat info {};
  if (lstat(capture_root.c_str(), &info) != 0) {
    error = std::string("capture root unavailable: ") + std::strerror(errno);
    return false;
  }
  if (!S_ISDIR(info.st_mode) || info.st_uid != geteuid() || (info.st_mode & 0777) != 0700) {
    error = "capture root ownership or mode is unsafe";
    return false;
  }
  return true;
}

bool direct_child(const std::string& capture_root, const std::string& path, std::string& error) {
  const std::string prefix = capture_root + "/";
  if (path.size() <= prefix.size() || path.compare(0, prefix.size(), prefix) != 0) {
    error = "capture file is outside the private capture root";
    return false;
  }
  const std::string name = path.substr(prefix.size());
  if (name.find('/') != std::string::npos || name == "." || name == "..") {
    error = "capture file is not a direct child";
    return false;
  }
  return true;
}

bool png_dimensions(const uint8_t* bytes, size_t length, uint32_t& width, uint32_t& height) {
  static const uint8_t signature[8] = {137, 80, 78, 71, 13, 10, 26, 10};
  if (length < 24 || std::memcmp(bytes, signature, sizeof(signature)) != 0) return false;
  if (std::memcmp(bytes + 12, "IHDR", 4) != 0) return false;
  width = (static_cast<uint32_t>(bytes[16]) << 24) | (static_cast<uint32_t>(bytes[17]) << 16) |
          (static_cast<uint32_t>(bytes[18]) << 8) | bytes[19];
  height = (static_cast<uint32_t>(bytes[20]) << 24) | (static_cast<uint32_t>(bytes[21]) << 16) |
           (static_cast<uint32_t>(bytes[22]) << 8) | bytes[23];
  return width > 0 && height > 0;
}

std::string sha256_hex(const uint8_t* bytes, size_t length) {
  uint8_t digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes, static_cast<CC_LONG>(length), digest);
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.reserve(sizeof(digest) * 2);
  for (uint8_t byte : digest) {
    out.push_back(hex[(byte >> 4) & 0x0f]);
    out.push_back(hex[byte & 0x0f]);
  }
  return out;
}

}  // namespace

bool verify_capture_file(const std::string& capture_root, const std::string& path,
                         const std::string& expected_sha256, uint32_t expected_width,
                         uint32_t expected_height, size_t& size, std::string& error) {
  size = 0;
  if (expected_sha256.size() != 64 || expected_width == 0 || expected_height == 0) {
    error = "capture facts are incomplete";
    return false;
  }
  if (!verify_root(capture_root, error) || !direct_child(capture_root, path, error)) return false;

  struct stat linked {};
  if (lstat(path.c_str(), &linked) != 0) {
    error = std::string("capture file lstat failed: ") + std::strerror(errno);
    return false;
  }
  if (!S_ISREG(linked.st_mode) || linked.st_uid != geteuid() ||
      (linked.st_mode & 0777) != 0600 || linked.st_nlink != 1) {
    error = "capture file ownership, mode or link count is unsafe";
    return false;
  }

  const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    error = std::string("capture file open failed: ") + std::strerror(errno);
    return false;
  }
  struct stat opened {};
  if (fstat(fd, &opened) != 0 || !S_ISREG(opened.st_mode) || opened.st_dev != linked.st_dev ||
      opened.st_ino != linked.st_ino || opened.st_uid != geteuid() ||
      (opened.st_mode & 0777) != 0600 || opened.st_nlink != 1) {
    error = "capture file changed after open";
    close(fd);
    return false;
  }
  if (opened.st_size <= 0 || static_cast<uint64_t>(opened.st_size) > kMaxCaptureBytes) {
    error = "capture file size is outside the bound";
    close(fd);
    return false;
  }
  std::string bytes(static_cast<size_t>(opened.st_size), '\0');
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t count = read(fd, bytes.data() + offset, bytes.size() - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      error = std::string("capture file read failed: ") + std::strerror(errno);
      close(fd);
      return false;
    }
    if (count == 0) break;
    offset += static_cast<size_t>(count);
  }
  close(fd);
  if (offset != bytes.size()) {
    error = "capture file short read";
    return false;
  }

  const std::string actual = sha256_hex(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size());
  if (actual != expected_sha256) {
    error = "capture file SHA-256 mismatch";
    return false;
  }
  uint32_t width = 0;
  uint32_t height = 0;
  if (!png_dimensions(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), width, height) ||
      width != expected_width || height != expected_height) {
    error = "capture PNG IHDR mismatch";
    return false;
  }
  size = bytes.size();
  return true;
}

}  // namespace zody::cua::desktop_session
