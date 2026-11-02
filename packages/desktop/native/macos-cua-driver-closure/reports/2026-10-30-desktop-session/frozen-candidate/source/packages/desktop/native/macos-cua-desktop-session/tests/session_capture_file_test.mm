#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonDigest.h>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <string>

#include "session_capture_file.h"

namespace {

using zody::cua::desktop_session::verify_capture_file;

int failures = 0;

void expect(bool condition, const char* message) {
  if (condition) return;
  std::fprintf(stderr, "FAIL: %s\n", message);
  failures += 1;
}

std::string make_root() {
  char pattern[] = "/tmp/zody-cua-capture-test.XXXXXX";
  char* created = mkdtemp(pattern);
  if (created == nullptr) return "";
  chmod(created, 0700);
  return created;
}

void write_bytes(const std::string& path, const std::string& bytes, mode_t mode) {
  const int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, mode);
  if (fd < 0) return;
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t count = write(fd, bytes.data() + offset, bytes.size() - offset);
    if (count <= 0) break;
    offset += static_cast<size_t>(count);
  }
  close(fd);
  chmod(path.c_str(), mode);
}

std::string sha256(const std::string& bytes) {
  uint8_t digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(reinterpret_cast<const uint8_t*>(bytes.data()),
            static_cast<CC_LONG>(bytes.size()), digest);
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.reserve(sizeof(digest) * 2);
  for (uint8_t byte : digest) {
    out.push_back(hex[(byte >> 4) & 0x0f]);
    out.push_back(hex[byte & 0x0f]);
  }
  return out;
}

std::string png(uint32_t width, uint32_t height) {
  std::string bytes(33, '\0');
  const unsigned char signature[8] = {137, 80, 78, 71, 13, 10, 26, 10};
  std::memcpy(bytes.data(), signature, sizeof(signature));
  bytes[8] = 0;
  bytes[9] = 0;
  bytes[10] = 0;
  bytes[11] = 13;
  std::memcpy(bytes.data() + 12, "IHDR", 4);
  bytes[16] = static_cast<char>((width >> 24) & 0xff);
  bytes[17] = static_cast<char>((width >> 16) & 0xff);
  bytes[18] = static_cast<char>((width >> 8) & 0xff);
  bytes[19] = static_cast<char>(width & 0xff);
  bytes[20] = static_cast<char>((height >> 24) & 0xff);
  bytes[21] = static_cast<char>((height >> 16) & 0xff);
  bytes[22] = static_cast<char>((height >> 8) & 0xff);
  bytes[23] = static_cast<char>(height & 0xff);
  return bytes;
}

void test_capture_file() {
  const std::string root = make_root();
  expect(!root.empty(), "capture root unavailable");
  if (root.empty()) return;
  const std::string good = png(640, 480);
  const std::string good_sha = sha256(good);
  const std::string path = root + "/capture.png";
  write_bytes(path, good, 0600);

  size_t size = 0;
  std::string error;
  expect(verify_capture_file(root, path, good_sha, 640, 480, size, error),
         "valid capture rejected");
  expect(size == good.size(), "capture size mismatch");

  expect(!verify_capture_file(root, path, std::string(64, '0'), 640, 480, size, error),
         "wrong SHA accepted");
  expect(!verify_capture_file(root, path, good_sha, 641, 480, size, error),
         "wrong width accepted");
  expect(!verify_capture_file(root, path, good_sha, 640, 481, size, error),
         "wrong height accepted");
  expect(!verify_capture_file(root, root + "/../capture.png", good_sha, 640, 480, size, error),
         "path traversal accepted");

  const std::string symlink_path = root + "/link.png";
  expect(symlink(path.c_str(), symlink_path.c_str()) == 0, "symlink fixture failed");
  expect(!verify_capture_file(root, symlink_path, good_sha, 640, 480, size, error),
         "symlink capture accepted");
  unlink(symlink_path.c_str());

  const std::string hardlink_path = root + "/hard.png";
  expect(link(path.c_str(), hardlink_path.c_str()) == 0, "hardlink fixture failed");
  expect(!verify_capture_file(root, hardlink_path, good_sha, 640, 480, size, error),
         "hardlinked capture accepted");
  unlink(hardlink_path.c_str());

  chmod(path.c_str(), 0644);
  expect(!verify_capture_file(root, path, good_sha, 640, 480, size, error),
         "group/world-readable capture accepted");
  chmod(path.c_str(), 0600);
  chmod(root.c_str(), 0755);
  expect(!verify_capture_file(root, path, good_sha, 640, 480, size, error),
         "non-private root accepted");
  chmod(root.c_str(), 0700);

  const std::string short_path = root + "/short.png";
  write_bytes(short_path, "not-a-png", 0600);
  expect(!verify_capture_file(root, short_path, sha256("not-a-png"), 1, 1, size, error),
         "non-PNG accepted");
  unlink(short_path.c_str());

  unlink(path.c_str());
  rmdir(root.c_str());
}

}  // namespace

int main() {
  @autoreleasepool {
    test_capture_file();
  }
  if (failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", failures);
    return 1;
  }
  std::printf("ok session-capture-file\n");
  return 0;
}
