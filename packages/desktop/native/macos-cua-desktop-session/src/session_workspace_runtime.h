#pragma once

#include <string>

namespace zody::cua::desktop_session {

struct WorkspaceRelayOptions {
  std::string entry_name;
  int host_bridge_fd = -1;
  int cli_input_fd = -1;
  int cli_output_fd = -1;
};

struct WorkspaceChildOptions {
  std::string entry_name;
  std::string rendezvous;
  std::string nonce;
};

// relay 侧：对已签名 self 做 preflight 后，经 NSWorkspace 以全新实例启动自身固定
// bundle；认证实际 child 的 audit token + 固定身份 + 同 CDHash，再把 stdio 与
// Host/CLI bridge fd 交接给 child。relay 不安装 native confirmation、不创建任何
// authority/lease；并监测真实父进程退出，避免孤儿 child。
int run_workspace_relay(const WorkspaceRelayOptions& options);

// child 侧交接结果：relay_fd 保留用于运行期 liveness；bridge fd 交给既有
// launch_trusted_session，stdio 已在 handoff 内重定向到 relay 传入的管道。
struct WorkspaceChildHandoff {
  std::string entry_name;
  int relay_fd = -1;
  int host_bridge_fd = -1;
  int cli_input_fd = -1;
  int cli_output_fd = -1;
};

// child 侧：连接固定 rendezvous，认证 relay，接收有界 context + fd bundle，
// 仅在认证通过后应用 cwd/env 并把 stdio 映射到继承管道。任何失败都返回 false，
// 由调用方以非零退出（supervisor 创建前的 EOF 不能被当成成功）。
bool workspace_child_handoff(const WorkspaceChildOptions& options, WorkspaceChildHandoff& handoff,
                             std::string& error);

// 一轮 supervised session 结束后写一个固定结构的 child-exit 帧；relay 只能凭该帧
// 传播退出码，缺失状态（EOF/崩溃）一律视为失败。
void workspace_child_report_status(int relay_fd, int code);

// 关闭 child 仍持有的 bridge fd；Node 已在 launch_session_node 内 dup 出自己的 5/6/7。
void workspace_child_close_bridge_fds(WorkspaceChildHandoff& handoff);

}  // namespace zody::cua::desktop_session
