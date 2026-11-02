#pragma once

#include <string>

#include "peer_socket.h"
#include "session_node_process.h"

namespace zody::cua::desktop_session {

struct LaunchSessionOptions {
  std::string entry_name;
  int host_bridge_fd = -1;
  int cli_input_fd = -1;
  int cli_output_fd = -1;
};

struct SessionLaunch {
  SessionNode node;
  int authority_listener = -1;
  SocketOwnership authority_ownership;
  std::string authority_endpoint;
  std::string run_dir;
  std::string capture_root;
  std::string entry_name;
  std::string entry_sha256;
  std::string producer_incarnation;
};

// 只允许固定 entry 名；入口/Node 字节、self 签名与 loaded code 均由本函数验证。
bool launch_trusted_session(const LaunchSessionOptions& options, SessionLaunch& launch,
                            std::string& error);
void shutdown_trusted_session(SessionLaunch& launch);

}  // namespace zody::cua::desktop_session
