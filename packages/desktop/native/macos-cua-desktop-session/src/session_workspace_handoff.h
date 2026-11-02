#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace zody::cua::desktop_session {

constexpr size_t kWorkspaceMaxContextBytes = 64 * 1024;
constexpr size_t kWorkspaceMaxEnvironmentEntries = 256;
constexpr size_t kWorkspaceMaxEnvironmentEntryBytes = 8 * 1024;
constexpr size_t kWorkspaceMaxCwdBytes = 4 * 1024;
constexpr size_t kWorkspaceMaxNonceBytes = 64;
constexpr size_t kWorkspaceMaxFds = 5;
constexpr uint8_t kWorkspaceFdMarker = 0x46;  // 'F'

struct WorkspaceContext {
  std::string entry_name;
  std::string nonce;
  std::string cwd;
  std::vector<std::string> env;
  size_t fd_count = 0;
};

struct WorkspaceBridgeFds {
  int host_bridge_fd = -1;
  int cli_input_fd = -1;
  int cli_output_fd = -1;
};

// 只用于 rendezvous 关联，不是授权凭据。身份由 audit token + pinned code 决定。
std::string workspace_nonce();
bool workspace_nonce_valid(const std::string& nonce);

// 环境只从当前进程快照，拒绝代码注入变量；值不会写入 argv 或日志。
bool workspace_collect_environment(std::vector<std::string>& env, std::string& error);
bool workspace_environment_entry_valid(const std::string& entry, std::string& error);

std::string workspace_context_json(const WorkspaceContext& context);
bool parse_workspace_context_json(const std::string& text, const std::string& expected_entry_name,
                                  const std::string& expected_nonce, WorkspaceContext& context,
                                  std::string& error);

// relay 侧按 entry 校验并收集要发送的 bridge fd；stdio 由调用方固定排在前面。
bool workspace_bridge_fds_for_entry(const std::string& entry_name, int host_bridge_fd,
                                    int cli_input_fd, int cli_output_fd,
                                    std::vector<int>& fds, std::string& error);
// child 侧按 entry 和精确数量拆出 bridge fd；不改变 stdio 的 0/1/2 约定。
bool workspace_bridge_fds_from_bundle(const std::string& entry_name,
                                      const std::vector<int>& received_fds,
                                      WorkspaceBridgeFds& bridge_fds, std::string& error);

// 中文原因：SCM 收到的 fd 在 child 自身 stdio 关闭时可能被内核分配成 0/1/2，
// 直接 dup2 映射 stdio 会覆盖后续作为源的 fd。先统一 dup 到 >=3，再映射。
bool workspace_rehome_fds(std::vector<int>& fds, std::string& error);

// 一次 sendmsg 发送一个 marker 字节和全部 fd。发送方只关闭自己创建的副本。
bool workspace_send_fds(int socket_fd, const std::vector<int>& source_fds, uint8_t marker,
                        std::string& error);
// 接收方必须拿到完整 control；短读/截断/数量不符时关闭所有已收到的 fd。
bool workspace_receive_fds(int socket_fd, size_t expected_count, uint8_t marker,
                           std::vector<int>& received_fds, std::string& error);
void workspace_close_fds(std::vector<int>& fds);

// child 的退出状态是 relay 判断成功的唯一依据；无状态 EOF 不是成功。
std::string workspace_child_exit_json(int code);
bool parse_workspace_child_exit_json(const std::string& text, int& code, std::string& error);

// 认证完成后才调用：切换 cwd 并替换环境；失败必须让 child 退出，不能带病启动。
bool workspace_apply_context(const WorkspaceContext& context, std::string& error);

}  // namespace zody::cua::desktop_session
