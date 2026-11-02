#include <signal.h>
#include <unistd.h>

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

namespace {

volatile sig_atomic_t g_signal_stop = 0;

void handle_signal(int) { g_signal_stop = 1; }

struct MainOptions {
  zody::cua::desktop_session::LaunchSessionOptions launch;
  bool launch_session = false;
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
  for (int index = 1; index < argc; ++index) {
    const std::string arg = argv[index];
    if (arg == "--launch-session") {
      options.launch_session = true;
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
    } else {
      return false;
    }
  }
  if (!options.launch_session || !saw_entry) return false;
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
               "usage: %s --launch-session --entry-name "
               "{host-entry.mjs|cli-entry.mjs|session-entry.mjs} "
               "[--host-fd N] [--cli-in-fd N --cli-out-fd N]\n",
               program);
}

}  // namespace

int main(int argc, char** argv) {
  @autoreleasepool {
    MainOptions options;
    if (!parse_args(argc, argv, options)) {
      print_usage(argv[0]);
      return 2;
    }

    zody::cua::desktop_session::ConfirmationController confirmation;
    if (!confirmation.install()) {
      std::fprintf(stderr, "native confirmation requires the main thread\n");
      return 2;
    }

    zody::cua::desktop_session::SessionLaunch launch;
    std::string error;
    if (!zody::cua::desktop_session::launch_trusted_session(options.launch, launch, error)) {
      std::fprintf(stderr, "trusted session launch refused: %s\n", error.c_str());
      return 2;
    }

    signal(SIGTERM, handle_signal);
    signal(SIGINT, handle_signal);
    signal(SIGHUP, handle_signal);

    zody::cua::desktop_session::SessionSupervisor supervisor(launch, confirmation);
    std::thread supervisor_thread([&supervisor] { supervisor.run(); });
    zody::cua::desktop_session::SessionSupervisor* supervisor_ptr = &supervisor;

    dispatch_source_t timer = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0),
                              250ull * NSEC_PER_MSEC, 50ull * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(timer, ^{
      if (g_signal_stop != 0) {
        // 中文原因：signal 只锁存停止并中断当前连接，不能先停 NSApp；否则
        // supervisor 可能正阻塞在 dispatch_sync(main, present)，主线程去 join 会死锁。
        // 主循环由 supervisor.run() 确认清理完成后自行停止。
        supervisor_ptr->requestStop("signal");
      }
    });
    dispatch_resume(timer);

    [NSApp run];

    confirmation.dismissAll();
    supervisor.requestStop("shutdown");
    if (supervisor_thread.joinable()) supervisor_thread.join();
    const int supervisor_code = supervisor.exitCode();
    const std::string failure_reason = supervisor.failureReason();
    zody::cua::desktop_session::shutdown_trusted_session(launch);
    const std::string child_status = launch.node.wait_status_text();
    if (supervisor_code != 0) {
      std::fprintf(stderr, "desktop session ended abnormally: %s; %s\n",
                   failure_reason.c_str(), child_status.c_str());
    }
    dispatch_source_cancel(timer);
    return supervisor_code;
  }
}
