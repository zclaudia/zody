#pragma once

#include <sys/types.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "peer_socket.h"
#include "r11_self_identity.h"

namespace zody::cua::desktop_session {

struct CellTransportConfig {
  std::string run_dir;
  std::string node_path;
  int node_fd = -1;
  std::string server_source;
  std::string server_sha256;
  // 只经 fd3 session-ready 交付给 sealed CLI 的瞬时 key；cell server 用它对
  // fresh challenge/source/bounds 生成 proof，不新增授权状态。
  std::string transport_authentication_key;
  zody::cua::round11::LoadedCodeExpectation node_loaded_code;
  pid_t cli_pid = -1;
  uid_t uid = 0;
  // 整个 relay 的安全硬上限，取既有 MCP 工具最大预算 30 分钟；实际 server/per-tool
  // timeout 与取消由外层 call signal 执行。到期仍 kill+reap，不能等待后代释放 fd4。
  int relay_timeout_ms = 1'800'000;
};

// Helper 私有的 cell 传输端点。listener、连接与 worker 都有明确上限：
// accept 线程 1 个、执行 slot 最多 kCellMaxConcurrent 个；unknown cleanup 占住 slot，
// 直到确认 kill+reap 才归还。Helper 只做原 fd3/fd4 字节双工中继，不解析 CellRequest。
class CellTransport {
 public:
  CellTransport();
  ~CellTransport();
  CellTransport(const CellTransport&) = delete;
  CellTransport& operator=(const CellTransport&) = delete;

  bool start(const CellTransportConfig& config, std::string& error);
  void stop();

  bool started() const { return started_.load(std::memory_order_acquire); }
  const std::string& endpoint() const { return endpoint_; }
  size_t activeWorkers() const;
  bool cleanupFullyKnown() const;

 private:
  void accept_loop();
  void run_worker(int client_fd, bool reserved_slot);
  bool reserve_slot();
  void release_slot(bool cleanup_known);
  void prune_finished_workers_locked();

  CellTransportConfig config_;
  std::string endpoint_;
  int listener_fd_ = -1;
  SocketOwnership ownership_;
  std::atomic<bool> stop_{false};
  std::atomic<bool> started_{false};

  struct WorkerRecord {
    std::thread thread;
    std::shared_ptr<std::atomic<bool>> done;
  };
  mutable std::mutex workers_mutex_;
  // 只保留未完成 worker；finished record 在 accept 循环和 stop 中 join 并移除，
  // 因此线程对象数量与 active slot 一样有界，不会随 accept 次数无限累积。
  std::vector<WorkerRecord> workers_;
  std::thread accept_thread_;
  size_t active_workers_ = 0;
  bool cleanup_unknown_ = false;
};

}  // namespace zody::cua::desktop_session
