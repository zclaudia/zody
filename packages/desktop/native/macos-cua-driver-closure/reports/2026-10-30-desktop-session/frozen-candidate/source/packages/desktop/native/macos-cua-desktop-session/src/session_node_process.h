#pragma once

#include <sys/types.h>

#include <string>

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

// 固定 argv；sealed ESM 只从校验后的内存快照走 stdin，额外通道只作为继承 fd。
bool launch_session_node(const std::string& node_path, int node_fd,
                         const std::string& sealed_js,
                         const zody::cua::round11::LoadedCodeExpectation& loaded_code,
                         const SessionNodeFds& fds, SessionNode& node, std::string& error);

}  // namespace zody::cua::desktop_session
