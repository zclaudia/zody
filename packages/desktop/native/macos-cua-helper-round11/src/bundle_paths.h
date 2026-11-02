#pragma once

#include <string>

namespace zody::cua::round11 {

struct ResourcePins {
  std::string node_sha256;
  std::string authority_sha256;
};

struct BundlePaths {
  std::string executable;
  std::string contents;
  std::string resources;
  std::string node;
  std::string authority_entry;
};

struct VerifiedResource {
  int fd = -1;
  std::string sha256;

  VerifiedResource() = default;
  ~VerifiedResource();
  VerifiedResource(const VerifiedResource&) = delete;
  VerifiedResource& operator=(const VerifiedResource&) = delete;
  VerifiedResource(VerifiedResource&& other) noexcept;
  VerifiedResource& operator=(VerifiedResource&& other) noexcept;

  void close();
};

bool resolve_bundle_paths(BundlePaths& paths, std::string& error);

// 中文原因：只按路径算 hash 再交给 Node 重新打开会留下替换窗口。这里在同一次
// O_NOFOLLOW 打开的 fd 上核验 owner/mode/hash，并把该 fd 原样交给后续消费者。
bool open_verified_resource(const std::string& path, const std::string& expected_sha256,
                            VerifiedResource& resource, std::string& error);
bool verify_path_matches_fd(const std::string& path, int fd, std::string& error);

// 把资源读成有界内存快照，并在同一 bytes 上做 SHA-256 校验；后续消费者只能
// 使用该快照，不能再打开可变原文件。
bool read_verified_snapshot(const std::string& path, const std::string& expected_sha256,
                            size_t max_bytes, std::string& bytes, std::string& error);

}  // namespace zody::cua::round11
