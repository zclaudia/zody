#pragma once

#include <sys/types.h>

#include <string>
#include <vector>

#include "r11_self_identity.h"

namespace zody::cua::desktop_session {

struct SessionNodeFds {
  int host_bridge_fd = -1;
  int cli_input_fd = -1;
  int cli_output_fd = -1;
};

struct SessionNode {
  pid_t pid = -1;
  int control_fd = -1;
  bool reaped = false;
  bool cleanup_pending = false;
  int wait_status = -1;
  bool wait_status_known = false;
  bool termination_signal_sent = false;

  SessionNode() = default;
  ~SessionNode();
  SessionNode(const SessionNode&) = delete;
  SessionNode& operator=(const SessionNode&) = delete;
  SessionNode(SessionNode&& other) noexcept;
  SessionNode& operator=(SessionNode&& other) noexcept;

  void close_control();
  void stop();
  // 非阻塞回收实际 child；仅用于退出诊断，不把“尚未退出”当成成功。
  void observe_exit();
  // 有界等待 child 退出并保留原始 wait status；超时只返回 false，不伪造完成。
  bool wait_for_exit_status(int timeout_ms);
  bool exited_cleanly() const;
  std::string wait_status_text() const;
};

struct SuspendedNodeVerification {
  bool verified = false;
  bool resumed = false;
  bool reaped = false;
  std::string reason;
  // 实际 verify_loaded_code_for_pid 返回的 loaded identity；只用于有界审计，
  // 不能由 ready/argv/env 自报字段填充。
  std::string loaded_identifier;
  std::string loaded_cdhash_hex;
  std::string loaded_leaf_sha256;
  bool entitlements_empty = false;
};

// 共享实现：子进程必须以 POSIX_SPAWN_START_SUSPENDED 启动。这里只按 posix_spawn
// 返回的真实 PID 读取内核/Security 身份；核验失败绝不 SIGCONT，直接 SIGKILL 并有界
// reap，调用方不得在该路径投递 source、CellRequest 或释放 capability。
bool verify_suspended_node_then_resume(
    pid_t pid, const zody::cua::round11::LoadedCodeExpectation& loaded_code,
    SuspendedNodeVerification& verification);

// 立即 SIGKILL 并有界等待回收；无法确认回收时返回 false（cleanup pending）。
bool kill_and_reap_suspended_node(pid_t pid, int timeout_ms, int& wait_status,
                                  bool& wait_status_known);

// 与 launch_session_node 相同的环境过滤；供 cell 使用，避免 cell 继承 NODE_OPTIONS 等。
std::vector<std::string> filtered_node_environment();

// 固定 argv；sealed ESM 只从校验后的内存快照走 stdin，额外通道只作为继承 fd。
bool launch_session_node(const std::string& node_path, int node_fd,
                         const std::string& sealed_js,
                         const zody::cua::round11::LoadedCodeExpectation& loaded_code,
                         const SessionNodeFds& fds, SessionNode& node, std::string& error);

}  // namespace zody::cua::desktop_session
