#pragma once

#import <Foundation/Foundation.h>

#include <sys/types.h>

#include <cstddef>
#include <string>

namespace zody::cua::desktop_session {

// cell.sock 只承载 Helper 与 CLI 本机进程之间的有界传输帧；原 fd3/fd4 字节流
// 在完成 open/ready 握手后原样中继，Helper 不解析 CellRequest/CellResponse。
constexpr size_t kCellControlMaxFrameBytes = 16 * 1024;
constexpr size_t kCellMaxRequestBytes = 1024 * 1024;
constexpr size_t kCellMaxResponseBytes = 32 * 1024 * 1024;

// 与 node_repl 的单会话串行执行边界一致：同一时刻只允许一个真正执行中的 cell，
// 另一个 slot 留给正在等待有界 kill/reap 的 worker。unknown cleanup 不提前归还。
constexpr size_t kCellMaxConcurrent = 2;

struct CellOpenRequest {
  std::string source_sha256;
  std::string challenge_hex;
  size_t request_max_bytes = 0;
  size_t response_max_bytes = 0;
};

bool parse_cell_open_frame(NSDictionary* frame, CellOpenRequest& request, std::string& error);
bool parse_cell_open_line(const std::string& line, size_t max_bytes, CellOpenRequest& request,
                          std::string& error);

std::string serialize_cell_ready(pid_t cell_pid);
std::string serialize_cell_error(const std::string& reason);
std::string serialize_cell_exit(bool reaped, bool exited, int exit_code, bool signaled,
                                int signal_value);

bool is_fixed_cell_reason(const std::string& reason);

}  // namespace zody::cua::desktop_session
