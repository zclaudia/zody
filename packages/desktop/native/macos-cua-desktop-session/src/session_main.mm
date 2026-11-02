#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>

#include <atomic>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>

#include "confirmation.h"
#include "session_launcher.h"
#include "session_supervisor.h"
#include "session_workspace_runtime.h"

namespace {

volatile sig_atomic_t g_signal_stop = 0;

void handle_signal(int) { g_signal_stop = 1; }

struct MainOptions {
  enum class Mode { Direct, Relay, Child };
  Mode mode = Mode::Direct;
  zody::cua::desktop_session::LaunchSessionOptions launch;
  zody::cua::desktop_session::WorkspaceChildOptions child;
};

bool parse_fd(const char* value, int& fd) {
  if (value == nullptr || *value == '\0') return false;
  char* end = nullptr;
  const long parsed = std::strtol(value, &end, 10);
  if (end == nullptr || *end != '\0' || parsed < 3 || parsed > 1024) return false;
  fd = static_cast<int>(parsed);
  return true;
}

bool parse_args(int argc, char** argv, MainOptions& options) {
  bool saw_entry = false;
  bool saw_host = false;
  bool saw_cli_in = false;
  bool saw_cli_out = false;
  bool saw_rendezvous = false;
  bool saw_nonce = false;
  bool launch_session = false;
  bool launch_via_workspace = false;
  bool workspace_child = false;
  std::string rendezvous;
  std::string nonce;
  for (int index = 1; index < argc; ++index) {
    const std::string arg = argv[index];
    if (arg == "--launch-session") {
      launch_session = true;
    } else if (arg == "--launch-via-workspace") {
      launch_via_workspace = true;
    } else if (arg == "--workspace-child") {
      workspace_child = true;
    } else if (arg == "--entry-name" && index + 1 < argc) {
      if (saw_entry) return false;
      options.launch.entry_name = argv[++index];
      saw_entry = true;
    } else if (arg == "--host-fd" && index + 1 < argc) {
      if (saw_host || !parse_fd(argv[++index], options.launch.host_bridge_fd)) return false;
      saw_host = true;
    } else if (arg == "--cli-in-fd" && index + 1 < argc) {
      if (saw_cli_in || !parse_fd(argv[++index], options.launch.cli_input_fd)) return false;
      saw_cli_in = true;
    } else if (arg == "--cli-out-fd" && index + 1 < argc) {
      if (saw_cli_out || !parse_fd(argv[++index], options.launch.cli_output_fd)) return false;
      saw_cli_out = true;
    } else if (arg == "--workspace-rendezvous" && index + 1 < argc) {
      if (saw_rendezvous) return false;
      rendezvous = argv[++index];
      saw_rendezvous = true;
    } else if (arg == "--workspace-nonce" && index + 1 < argc) {
      if (saw_nonce) return false;
      nonce = argv[++index];
      saw_nonce = true;
    } else if (arg.rfind("-psn_", 0) == 0) {
      // 中文原因：经 LaunchServices 启动时系统会追加 -psn_<n> process serial
      // number；只忽略这一固定前缀，其它未知参数仍然拒绝。
      continue;
    } else {
      return false;
    }
  }

  if (workspace_child) {
    // child 参数只携带 rendezvous 关联信息，不允许 launch/fd/bridge 参数。
    if (launch_session || launch_via_workspace || saw_host || saw_cli_in || saw_cli_out ||
        !saw_entry || !saw_rendezvous || !saw_nonce) {
      return false;
    }
    options.mode = MainOptions::Mode::Child;
    options.child.entry_name = options.launch.entry_name;
    options.child.rendezvous = rendezvous;
    options.child.nonce = nonce;
    return true;
  }

  // 直连模式保持既有合同：--launch-session 必选；--launch-via-workspace 只选择
  // LaunchServices 启动机制，可与 --launch-session 同时出现。
  if (!launch_session || !saw_entry || saw_rendezvous || saw_nonce) return false;
  options.mode = launch_via_workspace ? MainOptions::Mode::Relay : MainOptions::Mode::Direct;
  if (options.launch.entry_name == "host-entry.mjs") {
    if (!saw_host || saw_cli_in || saw_cli_out) return false;
  } else if (options.launch.entry_name == "cli-entry.mjs") {
    if (saw_host || !saw_cli_in || !saw_cli_out) return false;
    if (options.launch.cli_input_fd == options.launch.cli_output_fd) return false;
  } else if (options.launch.entry_name == "session-entry.mjs") {
    if (saw_cli_in != saw_cli_out) return false;
    if (saw_cli_in && options.launch.cli_input_fd == options.launch.cli_output_fd) return false;
  } else {
    return false;
  }
  return true;
}

void print_usage(const char* program) {
  std::fprintf(stderr,
               "usage: %s --launch-session [--launch-via-workspace] --entry-name "
               "{host-entry.mjs|cli-entry.mjs|session-entry.mjs} "
               "[--host-fd N] [--cli-in-fd N --cli-out-fd N]\n"
               "       %s --workspace-child --entry-name E "
               "--workspace-rendezvous /abs/peer.sock --workspace-nonce HEX\n",
               program, program);
}

// 启动阶段 liveness：handoff 之后 relay 可能已 EOF/信号。此时必须 fail closed，
// 不能在已失联的情况下继续 launch 或进入 supervisor。
bool relay_liveness_lost(int fd, std::string& reason) {
  if (g_signal_stop != 0) {
    reason = "signal";
    return true;
  }
  if (fd < 0) return false;
  struct pollfd descriptor {};
  descriptor.fd = fd;
  descriptor.events = POLLIN;
  int ready = 0;
  do {
    ready = poll(&descriptor, 1, 0);
  } while (ready < 0 && errno == EINTR);
  if (ready < 0) {
    reason = "relay-liveness-error";
    return true;
  }
  if (ready == 0) return false;
  char byte = 0;
  const ssize_t received = recv(fd, &byte, 1, 0);
  if (received < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return false;
  reason = received == 0 ? "relay-eof" : "relay-liveness-error";
  return true;
}

// 直接模式与 LS child 共用同一既有 supervisor/authority/lease 生命周期。liveness_fd
// >=0 时监听 relay rendezvous：运行期 EOF 立即走 requestStop，不新增 owner。
// 中文原因：confirmation 由 main 在 child handoff 之前创建并 install，这样 LS child
// 先完成 AppKit 启动登记再进有界 handoff，避免与 relay 等 NSWorkspace completion
// 互等；supervisor 必须复用同一实例，不能再创建第二个 confirmation 状态。
int run_supervised_session(const zody::cua::desktop_session::LaunchSessionOptions& options,
                           int liveness_fd,
                           zody::cua::desktop_session::WorkspaceChildHandoff* handoff,
                           zody::cua::desktop_session::ConfirmationController& confirmation) {
  using zody::cua::desktop_session::ConfirmationController;
  using zody::cua::desktop_session::SessionLaunch;
  using zody::cua::desktop_session::SessionSupervisor;
  using zody::cua::desktop_session::launch_trusted_session;
  using zody::cua::desktop_session::shutdown_trusted_session;

  // 中文原因：必须先装 signal handler 再 launch；否则 native setup 期间收到
  // SIGTERM 会走默认终止，留下已 spawn 的 Node 孤儿。
  signal(SIGTERM, handle_signal);
  signal(SIGINT, handle_signal);
  signal(SIGHUP, handle_signal);

  std::string startup_reason;
  if (relay_liveness_lost(liveness_fd, startup_reason)) {
    std::fprintf(stderr, "workspace session startup aborted: %s\n", startup_reason.c_str());
    return 1;
  }

  SessionLaunch launch;
  std::string error;
  if (!launch_trusted_session(options, launch, error)) {
    std::fprintf(stderr, "trusted session launch refused: %s\n", error.c_str());
    return 2;
  }

  if (handoff != nullptr) {
    // 中文原因：Node 已在 launch_trusted_session 内 dup 出自己的 5/6/7；立即关闭
    // child 原有的 bridge fd，避免 helper 一直持有 stdin/out 写端导致 EOF 不出现。
    zody::cua::desktop_session::workspace_child_close_bridge_fds(*handoff);
  }

  if (relay_liveness_lost(liveness_fd, startup_reason)) {
    std::fprintf(stderr, "workspace session startup aborted after launch: %s\n",
                 startup_reason.c_str());
    shutdown_trusted_session(launch);
    return 1;
  }

  SessionSupervisor supervisor(launch, confirmation);
  std::thread supervisor_thread([&supervisor] { supervisor.run(); });
  SessionSupervisor* supervisor_ptr = &supervisor;

  std::atomic<bool> liveness_stop{false};
  std::thread liveness_thread;
  if (liveness_fd >= 0) {
    liveness_thread = std::thread([&supervisor, &liveness_stop, liveness_fd] {
      while (!liveness_stop.load(std::memory_order_acquire)) {
        struct pollfd descriptor {};
        descriptor.fd = liveness_fd;
        descriptor.events = POLLIN;
        const int ready = poll(&descriptor, 1, 250);
        if (ready < 0 && errno == EINTR) continue;
        if (ready < 0) {
          // 中文原因：poll 失败不能静默退出让 capture 继续；必须 fail closed，
          // 通过既有 requestStop 中断当前连接。
          supervisor.requestStop("relay-liveness-error");
          break;
        }
        if (ready == 0) continue;
        char byte = 0;
        const ssize_t received = recv(liveness_fd, &byte, 1, 0);
        if (received < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) {
          continue;
        }
        // 中文原因：relay 关闭/失效必须立即中断当前 capture 等待；只置标志会让
        // capture_once 阻塞到超时，不能算真实取消。
        supervisor.requestStop("relay-eof");
        break;
      }
    });
  }

  dispatch_source_t timer = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0),
                            250ull * NSEC_PER_MSEC, 50ull * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(timer, ^{
    if (g_signal_stop != 0) {
      // 中文原因：signal 只锁存停止并中断当前连接，不能先停 NSApp；主循环由
      // supervisor.run() 确认清理完成后自行停止。
      supervisor_ptr->requestStop("signal");
    }
  });
  dispatch_resume(timer);

  [NSApp run];

  confirmation.dismissAll();
  supervisor.requestStop("shutdown");
  if (supervisor_thread.joinable()) supervisor_thread.join();

  liveness_stop.store(true, std::memory_order_release);
  if (liveness_thread.joinable()) liveness_thread.join();

  const int supervisor_code = supervisor.exitCode();
  const std::string failure_reason = supervisor.failureReason();
  shutdown_trusted_session(launch);
  const std::string child_status = launch.node.wait_status_text();
  if (supervisor_code != 0) {
    std::fprintf(stderr, "desktop session ended abnormally: %s; %s\n", failure_reason.c_str(),
                 child_status.c_str());
  }
  dispatch_source_cancel(timer);
  return supervisor_code;
}

}  // namespace

int main(int argc, char** argv) {
  @autoreleasepool {
    MainOptions options;
    if (!parse_args(argc, argv, options)) {
      print_usage(argv[0]);
      return 2;
    }

    if (options.mode == MainOptions::Mode::Relay) {
      zody::cua::desktop_session::WorkspaceRelayOptions relay;
      relay.entry_name = options.launch.entry_name;
      relay.host_bridge_fd = options.launch.host_bridge_fd;
      relay.cli_input_fd = options.launch.cli_input_fd;
      relay.cli_output_fd = options.launch.cli_output_fd;
      return zody::cua::desktop_session::run_workspace_relay(relay);
    }

    // 中文原因：Relay 不安装 confirmation；Direct/Child 在正式 launch 之前先 install
    // 同一个 AppKit 就绪的 confirmation 实例。child 必须先 finishLaunching，否则
    // NSWorkspace 会等它登记完成，而它在 handoff 里等 relay，形成启动互等。
    zody::cua::desktop_session::ConfirmationController confirmation;
    if (!confirmation.install()) {
      std::fprintf(stderr, "native confirmation requires the main thread\n");
      return 2;
    }

    if (options.mode == MainOptions::Mode::Child) {
      zody::cua::desktop_session::WorkspaceChildHandoff handoff;
      std::string error;
      if (!zody::cua::desktop_session::workspace_child_handoff(options.child, handoff, error)) {
        std::fprintf(stderr, "workspace child handoff refused: %s\n", error.c_str());
        return 2;
      }
      zody::cua::desktop_session::LaunchSessionOptions launch;
      launch.entry_name = handoff.entry_name;
      launch.host_bridge_fd = handoff.host_bridge_fd;
      launch.cli_input_fd = handoff.cli_input_fd;
      launch.cli_output_fd = handoff.cli_output_fd;
      const int code = run_supervised_session(launch, handoff.relay_fd, &handoff, confirmation);
      zody::cua::desktop_session::workspace_child_close_bridge_fds(handoff);
      zody::cua::desktop_session::workspace_child_report_status(handoff.relay_fd, code);
      if (handoff.relay_fd >= 0) (void)close(handoff.relay_fd);
      return code;
    }

    return run_supervised_session(options.launch, -1, nullptr, confirmation);
  }
}
