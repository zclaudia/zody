#pragma once

#include <sys/types.h>

#include <string>

#include "r11_self_identity.h"

namespace zody::cua::round11 {

struct AuthorityNode {
  pid_t pid = -1;
  int authority_fd = -1;
  bool reaped = false;
  bool cleanup_pending = false;

  AuthorityNode() = default;
  ~AuthorityNode();
  AuthorityNode(const AuthorityNode&) = delete;
  AuthorityNode& operator=(const AuthorityNode&) = delete;
  AuthorityNode(AuthorityNode&& other) noexcept;
  AuthorityNode& operator=(AuthorityNode&& other) noexcept;

  void close_authority();
  int release_authority_fd();
  void stop();
};

// 固定 argv：node --jitless --no-warnings --input-type=module；JS 来自已校验
// 的同一个 fd（stdin），不按路径重开。FD3 是 authority NDJSON 私有通道。
// env 仅保留固定最小集合，清除 NODE_OPTIONS/NODE_PATH/DYLD_* 等。
bool launch_authority_node(const std::string& node_path, int node_fd,
                           const std::string& authority_js_snapshot,
                           const LoadedCodeExpectation& loaded_code, AuthorityNode& node,
                           std::string& error);

}  // namespace zody::cua::round11
