#include "session_workspace_handoff.h"

#import <Foundation/Foundation.h>
#import <Security/Security.h>

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <set>
#include <string>
#include <vector>

extern char** environ;

namespace zody::cua::desktop_session {
namespace {

constexpr int kWorkspaceIoTimeoutMs = 5'000;

bool starts_with(const std::string& value, const char* prefix) {
  const size_t length = std::strlen(prefix);
  return value.size() >= length && std::memcmp(value.data(), prefix, length) == 0;
}

bool contains_forbidden_bytes(const std::string& value) {
  return value.find('\0') != std::string::npos || value.find('\n') != std::string::npos ||
         value.find('\r') != std::string::npos;
}

bool blocked_environment_name(const std::string& name) {
  // 中文原因：这些变量能改变动态加载或 Node 代码解析，即便值来自可信父端也不能
  // 通过 LS 环境移交绕过 sealed entry/launcher 的固定材料边界。
  return starts_with(name, "DYLD_") || starts_with(name, "LD_") ||
         starts_with(name, "NODE_REPL_") || name == "NODE_OPTIONS" || name == "NODE_PATH" ||
         name == "ELECTRON_RUN_AS_NODE" || name == "NODE_EXTRA_CA_CERTS" ||
         // 中文原因：LaunchServices/XPC 身份元数据属于 relay 自身进程上下文，交给
         // LS 独立 child 会覆盖其系统值；剔除后 child 保留自己的 LaunchServices 身份。
         // 这些只是进程元数据，不是授权依据；身份仍以 audit token + Security 为准。
         name == "__CFBundleIdentifier" || name == "XPC_SERVICE_NAME" || name == "XPC_FLAGS" ||
         name == "LaunchInstanceID";
}

bool environment_name_valid(const std::string& name) {
  if (name.empty()) return false;
  const auto is_alpha = [](unsigned char byte) {
    return (byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z') || byte == '_';
  };
  const auto is_digit = [](unsigned char byte) { return byte >= '0' && byte <= '9'; };
  if (!is_alpha(static_cast<unsigned char>(name[0]))) return false;
  for (size_t index = 1; index < name.size(); ++index) {
    const unsigned char byte = static_cast<unsigned char>(name[index]);
    if (!is_alpha(byte) && !is_digit(byte)) return false;
  }
  return true;
}

bool split_environment_entry(const std::string& entry, std::string& name, std::string& value) {
  const size_t equals = entry.find('=');
  if (equals == std::string::npos) return false;
  name = entry.substr(0, equals);
  value = entry.substr(equals + 1);
  return true;
}

bool environment_entry_valid(const std::string& entry, std::string& error) {
  if (entry.empty() || entry.size() > kWorkspaceMaxEnvironmentEntryBytes ||
      contains_forbidden_bytes(entry)) {
    error = "workspace environment entry is empty, too large, or contains a control newline";
    return false;
  }
  std::string name;
  std::string value;
  if (!split_environment_entry(entry, name, value) || !environment_name_valid(name)) {
    error = "workspace environment entry name is invalid";
    return false;
  }
  if (blocked_environment_name(name)) {
    error = "workspace environment contains a blocked code-injection variable";
    return false;
  }
  return true;
}

bool wait_fd(int fd, short events, std::string& error) {
  const auto deadline = std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(kWorkspaceIoTimeoutMs);
  while (true) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                               deadline - std::chrono::steady_clock::now())
                               .count();
    if (remaining <= 0) {
      error = "workspace handoff io timed out";
      return false;
    }
    struct pollfd descriptor {};
    descriptor.fd = fd;
    descriptor.events = events;
    const int ready = poll(&descriptor, 1, static_cast<int>(remaining));
    if (ready > 0) {
      // HUP/ERR 也要让 recvmsg 返回真实 EOF/错误，不能把关闭误判成可读成功。
      if ((descriptor.revents & (events | POLLHUP | POLLERR | POLLNVAL)) != 0) return true;
      error = "workspace handoff socket has an unexpected poll state";
      return false;
    }
    if (ready == 0) {
      error = "workspace handoff io timed out";
      return false;
    }
    if (errno != EINTR) {
      error = std::string("workspace handoff poll failed: ") + std::strerror(errno);
      return false;
    }
  }
}

bool ns_string_from_utf8(const std::string& value, NSString** result) {
  if (result == nullptr) return false;
  *result = [[NSString alloc] initWithBytes:value.data()
                                    length:value.size()
                                  encoding:NSUTF8StringEncoding];
  return *result != nil;
}

bool std_string_from_ns(id value, std::string& result) {
  if (![value isKindOfClass:[NSString class]]) return false;
  NSData* data = [static_cast<NSString*>(value) dataUsingEncoding:NSUTF8StringEncoding
                                            allowLossyConversion:NO];
  if (data == nil) return false;
  result.assign(static_cast<const char*>(data.bytes), data.length);
  return true;
}

bool strict_int(id value, int expected) {
  if (value == nil || CFGetTypeID((__bridge CFTypeRef)value) != CFNumberGetTypeID()) return false;
  int actual = 0;
  if (!CFNumberGetValue((__bridge CFNumberRef)value, kCFNumberIntType, &actual)) return false;
  return actual == expected;
}

bool exact_keys(NSDictionary* dictionary, NSArray<NSString*>* keys) {
  if (dictionary.count != keys.count) return false;
  for (NSString* key in keys) {
    if (dictionary[key] == nil) return false;
  }
  return true;
}

bool valid_cwd(const std::string& cwd, std::string& error) {
  if (cwd.empty() || cwd[0] != '/' || cwd.size() > kWorkspaceMaxCwdBytes ||
      contains_forbidden_bytes(cwd)) {
    error = "workspace cwd must be an absolute bounded path";
    return false;
  }
  struct stat info {};
  if (stat(cwd.c_str(), &info) != 0 || !S_ISDIR(info.st_mode)) {
    error = "workspace cwd is not an accessible directory";
    return false;
  }
  return true;
}

bool valid_fd_count_for_entry(const std::string& entry_name, size_t fd_count) {
  if (entry_name == "host-entry.mjs") return fd_count == 4;
  if (entry_name == "cli-entry.mjs") return fd_count == 5;
  if (entry_name == "session-entry.mjs") return fd_count == 3 || fd_count == 5;
  return false;
}

}  // namespace

std::string workspace_nonce() {
  unsigned char bytes[16];
  if (SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes) != errSecSuccess) return "";
  static const char* hex = "0123456789abcdef";
  std::string nonce;
  nonce.reserve(sizeof(bytes) * 2);
  for (unsigned char byte : bytes) {
    nonce.push_back(hex[(byte >> 4) & 0x0f]);
    nonce.push_back(hex[byte & 0x0f]);
  }
  return nonce;
}

bool workspace_nonce_valid(const std::string& nonce) {
  if (nonce.size() != 32 && nonce.size() != 64) return false;
  for (unsigned char byte : nonce) {
    if (!((byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'f'))) return false;
  }
  return true;
}

bool workspace_environment_entry_valid(const std::string& entry, std::string& error) {
  return environment_entry_valid(entry, error);
}

bool workspace_collect_environment(std::vector<std::string>& env, std::string& error) {
  env.clear();
  size_t total = 0;
  for (char** entry = environ; entry != nullptr && *entry != nullptr; ++entry) {
    const std::string value(*entry);
    std::string name;
    std::string ignored;
    if (!split_environment_entry(value, name, ignored)) continue;
    if (blocked_environment_name(name)) continue;
    std::string validation_error;
    if (!environment_entry_valid(value, validation_error)) {
      error = validation_error;
      env.clear();
      return false;
    }
    NSString* string = nil;
    if (!ns_string_from_utf8(value, &string)) {
      error = "workspace environment contains non-UTF8 bytes";
      env.clear();
      return false;
    }
    total += value.size() + 1;
    if (env.size() >= kWorkspaceMaxEnvironmentEntries ||
        total > kWorkspaceMaxContextBytes / 2) {
      error = "workspace environment is outside the bounded handoff size";
      env.clear();
      return false;
    }
    env.push_back(value);
  }
  return true;
}

std::string workspace_context_json(const WorkspaceContext& context) {
  std::string cwd_error;
  if (context.entry_name.empty() || !workspace_nonce_valid(context.nonce) ||
      !valid_cwd(context.cwd, cwd_error) || !valid_fd_count_for_entry(context.entry_name,
                                                                      context.fd_count)) {
    return "";
  }
  NSMutableArray<NSString*>* environment = [NSMutableArray array];
  for (const std::string& entry : context.env) {
    std::string error;
    if (!environment_entry_valid(entry, error)) return "";
    NSString* string = nil;
    if (!ns_string_from_utf8(entry, &string)) return "";
    [environment addObject:string];
  }
  NSString* entry_name = nil;
  NSString* nonce = nil;
  NSString* cwd = nil;
  if (!ns_string_from_utf8(context.entry_name, &entry_name) ||
      !ns_string_from_utf8(context.nonce, &nonce) || !ns_string_from_utf8(context.cwd, &cwd)) {
    return "";
  }
  NSDictionary* object = @{
    @"schemaVersion" : @1,
    @"role" : @"workspace-child",
    @"entryName" : entry_name,
    @"nonce" : nonce,
    @"cwd" : cwd,
    @"env" : environment,
    @"fdCount" : @(context.fd_count),
  };
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:object
                                                options:NSJSONWritingSortedKeys
                                                  error:&error];
  if (data == nil || error != nil || data.length == 0 || data.length > kWorkspaceMaxContextBytes) {
    return "";
  }
  return std::string(static_cast<const char*>(data.bytes), data.length);
}

bool parse_workspace_context_json(const std::string& text, const std::string& expected_entry_name,
                                  const std::string& expected_nonce, WorkspaceContext& context,
                                  std::string& error) {
  context = WorkspaceContext();
  if (text.empty() || text.size() > kWorkspaceMaxContextBytes) {
    error = "workspace context frame is empty or too large";
    return false;
  }
  NSData* data = [NSData dataWithBytes:text.data() length:text.size()];
  NSError* json_error = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&json_error];
  if (parsed == nil || json_error != nil || ![parsed isKindOfClass:[NSDictionary class]]) {
    error = "workspace context is not a JSON object";
    return false;
  }
  NSDictionary* object = static_cast<NSDictionary*>(parsed);
  if (!exact_keys(object,
                  @[ @"schemaVersion", @"role", @"entryName", @"nonce", @"cwd", @"env", @"fdCount" ]) ||
      !strict_int(object[@"schemaVersion"], 1) ||
      ![object[@"role"] isKindOfClass:[NSString class]] ||
      ![object[@"role"] isEqualToString:@"workspace-child"] ||
      !std_string_from_ns(object[@"entryName"], context.entry_name) ||
      !std_string_from_ns(object[@"nonce"], context.nonce) ||
      !std_string_from_ns(object[@"cwd"], context.cwd) ||
      ![object[@"env"] isKindOfClass:[NSArray class]]) {
    error = "workspace context shape is invalid";
    return false;
  }
  if (context.entry_name != expected_entry_name || context.nonce != expected_nonce ||
      !workspace_nonce_valid(context.nonce)) {
    error = "workspace context entry or nonce association mismatch";
    return false;
  }
  if (!valid_cwd(context.cwd, error)) return false;
  if (object[@"fdCount"] == nil ||
      CFGetTypeID((__bridge CFTypeRef)object[@"fdCount"]) != CFNumberGetTypeID()) {
    error = "workspace fd count is missing or not a number";
    return false;
  }
  int fd_count = 0;
  if (!CFNumberGetValue((__bridge CFNumberRef)object[@"fdCount"], kCFNumberIntType, &fd_count) ||
      fd_count < 3 || fd_count > static_cast<int>(kWorkspaceMaxFds) ||
      !valid_fd_count_for_entry(context.entry_name, static_cast<size_t>(fd_count))) {
    error = "workspace fd count does not match the entry";
    return false;
  }
  context.fd_count = static_cast<size_t>(fd_count);
  NSArray* environment = static_cast<NSArray*>(object[@"env"]);
  if (environment.count > kWorkspaceMaxEnvironmentEntries) {
    error = "workspace environment entry count exceeds the bound";
    return false;
  }
  size_t total = 0;
  for (id value in environment) {
    std::string entry;
    if (!std_string_from_ns(value, entry) || !environment_entry_valid(entry, error)) {
      if (error.empty()) error = "workspace environment entry is invalid";
      context = WorkspaceContext();
      return false;
    }
    total += entry.size() + 1;
    if (total > kWorkspaceMaxContextBytes / 2) {
      error = "workspace environment exceeds the bounded handoff size";
      context = WorkspaceContext();
      return false;
    }
    context.env.push_back(std::move(entry));
  }
  return true;
}

bool workspace_bridge_fds_for_entry(const std::string& entry_name, int host_bridge_fd,
                                    int cli_input_fd, int cli_output_fd,
                                    std::vector<int>& fds, std::string& error) {
  fds = {STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO};
  const bool has_host = host_bridge_fd >= 0;
  const bool has_cli_in = cli_input_fd >= 0;
  const bool has_cli_out = cli_output_fd >= 0;
  if (entry_name == "host-entry.mjs") {
    if (!has_host || has_cli_in || has_cli_out || host_bridge_fd < 3) {
      error = "host workspace handoff requires exactly one host bridge fd";
      return false;
    }
    fds.push_back(host_bridge_fd);
  } else if (entry_name == "cli-entry.mjs") {
    if (has_host || !has_cli_in || !has_cli_out || cli_input_fd < 3 || cli_output_fd < 3 ||
        cli_input_fd == cli_output_fd) {
      error = "cli workspace handoff requires two distinct cli bridge fds";
      return false;
    }
    fds.push_back(cli_input_fd);
    fds.push_back(cli_output_fd);
  } else if (entry_name == "session-entry.mjs") {
    if (has_host) {
      error = "session workspace handoff cannot include a host bridge fd";
      return false;
    }
    if (has_cli_in != has_cli_out || (has_cli_in && (cli_input_fd < 3 || cli_output_fd < 3 ||
                                                      cli_input_fd == cli_output_fd))) {
      error = "session workspace handoff cli bridge fds are invalid";
      return false;
    }
    if (has_cli_in) {
      fds.push_back(cli_input_fd);
      fds.push_back(cli_output_fd);
    }
  } else {
    error = "workspace handoff entry name is not allowed";
    return false;
  }
  return true;
}

bool workspace_bridge_fds_from_bundle(const std::string& entry_name,
                                      const std::vector<int>& received_fds,
                                      WorkspaceBridgeFds& bridge_fds, std::string& error) {
  bridge_fds = WorkspaceBridgeFds();
  if (received_fds.size() < 3 || received_fds.size() > kWorkspaceMaxFds) {
    error = "workspace fd bundle has an invalid count";
    return false;
  }
  if (entry_name == "host-entry.mjs") {
    if (received_fds.size() != 4 || received_fds[3] < 0) {
      error = "host workspace fd bundle must contain stdio and one host fd";
      return false;
    }
    bridge_fds.host_bridge_fd = received_fds[3];
  } else if (entry_name == "cli-entry.mjs") {
    if (received_fds.size() != 5 || received_fds[3] < 0 || received_fds[4] < 0 ||
        received_fds[3] == received_fds[4]) {
      error = "cli workspace fd bundle must contain stdio and two distinct cli fds";
      return false;
    }
    bridge_fds.cli_input_fd = received_fds[3];
    bridge_fds.cli_output_fd = received_fds[4];
  } else if (entry_name == "session-entry.mjs") {
    if (received_fds.size() == 5) {
      bridge_fds.cli_input_fd = received_fds[3];
      bridge_fds.cli_output_fd = received_fds[4];
    } else if (received_fds.size() != 3) {
      error = "session workspace fd bundle must contain stdio only or stdio plus cli fds";
      return false;
    }
  } else {
    error = "workspace fd bundle entry name is not allowed";
    return false;
  }
  return true;
}

void workspace_close_fds(std::vector<int>& fds) {
  for (int fd : fds) {
    if (fd >= 0) (void)close(fd);
  }
  fds.clear();
}

bool workspace_rehome_fds(std::vector<int>& fds, std::string& error) {
  if (fds.empty() || fds.size() > kWorkspaceMaxFds) {
    error = "workspace fd bundle has an invalid count";
    return false;
  }
  std::vector<int> rehomed;
  rehomed.reserve(fds.size());
  // 中文原因：先把所有收到的 fd dup 到 >=3，避免后续 dup2(stdio) 覆盖那些恰好被
  // 内核分配到 0/1/2 的 bridge fd。任一失败统一关闭已复制的副本和原始 fd。
  bool ok = true;
  for (int source : fds) {
    if (source < 0) {
      error = "workspace fd bundle contains a closed descriptor";
      ok = false;
      break;
    }
    const int copy = fcntl(source, F_DUPFD_CLOEXEC, 3);
    if (copy < 0) {
      error = std::string("cannot rehome workspace fd above stdio: ") + std::strerror(errno);
      ok = false;
      break;
    }
    rehomed.push_back(copy);
  }
  if (!ok) {
    workspace_close_fds(rehomed);
    workspace_close_fds(fds);
    return false;
  }
  workspace_close_fds(fds);
  fds = std::move(rehomed);
  return true;
}

bool workspace_send_fds(int socket_fd, const std::vector<int>& source_fds, uint8_t marker,
                        std::string& error) {
  if (socket_fd < 0 || source_fds.empty() || source_fds.size() > kWorkspaceMaxFds) {
    error = "workspace fd send arguments are invalid";
    return false;
  }
  std::vector<int> copies;
  copies.reserve(source_fds.size());
  for (int source : source_fds) {
    if (source < 0) {
      error = "workspace fd send source is closed";
      workspace_close_fds(copies);
      return false;
    }
    const int copy = fcntl(source, F_DUPFD_CLOEXEC, 3);
    if (copy < 0) {
      error = std::string("cannot duplicate workspace fd: ") + std::strerror(errno);
      workspace_close_fds(copies);
      return false;
    }
    copies.push_back(copy);
  }

  char control[CMSG_SPACE(sizeof(int) * kWorkspaceMaxFds)] = {0};
  struct msghdr message {};
  struct iovec io {};
  uint8_t payload = marker;
  io.iov_base = &payload;
  io.iov_len = 1;
  message.msg_iov = &io;
  message.msg_iovlen = 1;
  message.msg_control = control;
  message.msg_controllen = CMSG_SPACE(sizeof(int) * copies.size());
  struct cmsghdr* header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET;
  header->cmsg_type = SCM_RIGHTS;
  header->cmsg_len = CMSG_LEN(sizeof(int) * copies.size());
  std::memcpy(CMSG_DATA(header), copies.data(), sizeof(int) * copies.size());

  ssize_t sent = -1;
  while (true) {
    sent = sendmsg(socket_fd, &message, MSG_NOSIGNAL);
    if (sent >= 0) break;
    if (errno == EINTR) continue;
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      if (!wait_fd(socket_fd, POLLOUT, error)) {
        workspace_close_fds(copies);
        return false;
      }
      continue;
    }
    error = std::string("workspace fd sendmsg failed: ") + std::strerror(errno);
    workspace_close_fds(copies);
    return false;
  }
  workspace_close_fds(copies);
  if (sent != 1) {
    error = "workspace fd sendmsg did not send exactly one marker byte";
    return false;
  }
  return true;
}

bool workspace_receive_fds(int socket_fd, size_t expected_count, uint8_t marker,
                           std::vector<int>& received_fds, std::string& error) {
  received_fds.clear();
  if (socket_fd < 0 || expected_count == 0 || expected_count > kWorkspaceMaxFds) {
    error = "workspace fd receive arguments are invalid";
    return false;
  }
  char control[CMSG_SPACE(sizeof(int) * kWorkspaceMaxFds)] = {0};
  uint8_t payload = 0;
  struct iovec io {};
  io.iov_base = &payload;
  io.iov_len = 1;
  struct msghdr message {};
  message.msg_iov = &io;
  message.msg_iovlen = 1;
  message.msg_control = control;
  message.msg_controllen = sizeof(control);

  ssize_t received = -1;
  while (true) {
    message.msg_flags = 0;
    message.msg_controllen = sizeof(control);
    received = recvmsg(socket_fd, &message, 0);
    if (received >= 0) break;
    if (errno == EINTR) continue;
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      if (!wait_fd(socket_fd, POLLIN, error)) return false;
      continue;
    }
    error = std::string("workspace fd recvmsg failed: ") + std::strerror(errno);
    return false;
  }
  // 中文原因：marker 和 SCM_RIGHTS 在 stream 上不能假定一次 recvmsg 同时完整
  // 到达；先把control里已经交付的 fd 全部解析出来，再统一校验 marker/截断/数量。
  // 任何失败都必须关闭已收到的 fd，不能让控制消息错误造成描述符泄漏。
  bool saw_rights = false;
  // 中文原因：先把 control 中已交付的全部 fd 收进 received_fds，再统一做负值/
  // CLOEXEC 校验；若在遍历中直接 fcntl 失败 return，同一 control 里尚未 push 的
  // 描述符会漏关。统一失败 cleanup 关闭所有已收集 fd。
  for (struct cmsghdr* header = CMSG_FIRSTHDR(&message); header != nullptr;
       header = CMSG_NXTHDR(&message, header)) {
    if (header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS) {
      error = "workspace fd control message contains an unexpected type";
      workspace_close_fds(received_fds);
      return false;
    }
    saw_rights = true;
    if (header->cmsg_len < CMSG_LEN(0)) {
      error = "workspace fd control message is shorter than its header";
      workspace_close_fds(received_fds);
      return false;
    }
    const size_t bytes = header->cmsg_len - CMSG_LEN(0);
    if (bytes == 0 || bytes % sizeof(int) != 0) {
      error = "workspace fd control message has an invalid length";
      workspace_close_fds(received_fds);
      return false;
    }
    const size_t count = bytes / sizeof(int);
    const int* values = reinterpret_cast<const int*>(CMSG_DATA(header));
    for (size_t index = 0; index < count; ++index) {
      received_fds.push_back(values[index]);
    }
  }
  if (received_fds.size() > kWorkspaceMaxFds) {
    error = "workspace fd control message delivers too many descriptors";
    workspace_close_fds(received_fds);
    return false;
  }
  for (int fd : received_fds) {
    if (fd < 0) {
      error = "workspace fd control message contains a closed descriptor";
      workspace_close_fds(received_fds);
      return false;
    }
  }
  for (int fd : received_fds) {
    if (fcntl(fd, F_SETFD, FD_CLOEXEC) != 0) {
      error = std::string("cannot set CLOEXEC on received workspace fd: ") + std::strerror(errno);
      workspace_close_fds(received_fds);
      return false;
    }
  }
  if (received == 0) {
    error = "workspace fd stream ended before fds were received";
    workspace_close_fds(received_fds);
    return false;
  }
  if (received != 1 || payload != marker) {
    error = "workspace fd marker is invalid";
    workspace_close_fds(received_fds);
    return false;
  }
  if ((message.msg_flags & MSG_CTRUNC) != 0) {
    error = "workspace fd control message was truncated";
    workspace_close_fds(received_fds);
    return false;
  }
  if (!saw_rights || received_fds.size() != expected_count) {
    error = "workspace fd bundle count does not match the expected entry channels";
    workspace_close_fds(received_fds);
    return false;
  }
  return true;
}

std::string workspace_child_exit_json(int code) {
  NSDictionary* object = @{
    @"schemaVersion" : @1,
    @"type" : @"workspace-child-exit",
    @"code" : @(code),
  };
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:object
                                                options:NSJSONWritingSortedKeys
                                                  error:&error];
  if (data == nil || error != nil) return "";
  return std::string(static_cast<const char*>(data.bytes), data.length);
}

bool parse_workspace_child_exit_json(const std::string& text, int& code, std::string& error) {
  code = -1;
  if (text.empty() || text.size() > 4096) {
    error = "workspace child status frame is empty or too large";
    return false;
  }
  NSData* data = [NSData dataWithBytes:text.data() length:text.size()];
  NSError* json_error = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&json_error];
  if (parsed == nil || json_error != nil || ![parsed isKindOfClass:[NSDictionary class]]) {
    error = "workspace child status is not a JSON object";
    return false;
  }
  NSDictionary* object = static_cast<NSDictionary*>(parsed);
  if (!exact_keys(object, @[ @"schemaVersion", @"type", @"code" ]) ||
      !strict_int(object[@"schemaVersion"], 1) ||
      ![object[@"type"] isKindOfClass:[NSString class]] ||
      ![object[@"type"] isEqualToString:@"workspace-child-exit"] ||
      object[@"code"] == nil || CFGetTypeID((__bridge CFTypeRef)object[@"code"]) !=
                                   CFNumberGetTypeID()) {
    error = "workspace child status shape is invalid";
    return false;
  }
  int parsed_code = -1;
  if (!CFNumberGetValue((__bridge CFNumberRef)object[@"code"], kCFNumberIntType, &parsed_code) ||
      parsed_code < 0 || parsed_code > 255) {
    error = "workspace child status code is outside the bound";
    return false;
  }
  code = parsed_code;
  return true;
}

bool workspace_apply_context(const WorkspaceContext& context, std::string& error) {
  if (!valid_cwd(context.cwd, error)) return false;
  if (chdir(context.cwd.c_str()) != 0) {
    error = std::string("workspace chdir failed: ") + std::strerror(errno);
    return false;
  }
  std::vector<std::string> names;
  for (char** entry = environ; entry != nullptr && *entry != nullptr; ++entry) {
    std::string name;
    std::string ignored;
    if (split_environment_entry(std::string(*entry), name, ignored) && !name.empty()) {
      names.push_back(name);
    }
  }
  for (const std::string& name : names) (void)unsetenv(name.c_str());
  for (const std::string& entry : context.env) {
    std::string name;
    std::string value;
    if (!environment_entry_valid(entry, error) ||
        !split_environment_entry(entry, name, value) || setenv(name.c_str(), value.c_str(), 1) != 0) {
      if (error.empty()) error = std::string("workspace setenv failed: ") + std::strerror(errno);
      return false;
    }
  }
  // cwd 已经切换；同步 PWD 以免 provider 读取到父进程遗留的路径字符串。
  if (setenv("PWD", context.cwd.c_str(), 1) != 0) {
    error = std::string("workspace PWD update failed: ") + std::strerror(errno);
    return false;
  }
  return true;
}

}  // namespace zody::cua::desktop_session
