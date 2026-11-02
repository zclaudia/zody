#pragma once

#include <cstdint>
#include <string>

namespace zody::cua::round11 {

struct WindowTarget {
  uint32_t window_id = 0;
  int32_t pid = 0;
  int32_t layer = 0;
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
  std::string output_path;
};

// 显式开发单次链。缺少签名 pin、资源快照或 visual 静态库时明确 blocked，
// 不产生成功 stub、不发布 finalFrame。
int run_once(const WindowTarget& target, std::string& status, std::string& reason);
int run_helper(const std::string& peer_socket, const WindowTarget& target, std::string& status,
               std::string& reason);

}  // namespace zody::cua::round11
