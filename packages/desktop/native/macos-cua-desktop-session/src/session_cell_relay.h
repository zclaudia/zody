#pragma once

#include <atomic>
#include <cstddef>
#include <string>

namespace zody::cua::desktop_session {

// Helper 只把 CLI 的原始 fd3 字节写入 cell fd3，并把 cell fd4 字节写回 CLI；
// 不解析 CellRequest/CellResponse。单个原始 frame 的累计字节数仍由这里执行上限，
// 不能只依赖 open 帧声明。EOF/abort/超时都必须有界返回，由调用方 kill+reap。
enum class CellRelayOutcome {
  Completed,
  ClientEof,
  Aborted,
  RequestBoundExceeded,
  ResponseBoundExceeded,
  TimedOut,
  Stopped,
};

struct CellRelayLimits {
  size_t request_max_bytes = 0;
  size_t response_max_bytes = 0;
  int timeout_ms = 0;
};

CellRelayOutcome relay_cell_streams(int client_fd, int request_write, int response_read,
                                    const CellRelayLimits& limits,
                                    const std::atomic<bool>& stop, std::string& error);

}  // namespace zody::cua::desktop_session
