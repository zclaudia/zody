#import <Foundation/Foundation.h>

#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string>

#include "session_node_process.h"

extern char** environ;

namespace {

using zody::cua::desktop_session::SuspendedNodeVerification;
using zody::cua::desktop_session::kill_and_reap_suspended_node;
using zody::cua::desktop_session::verify_suspended_node_then_resume;

int failures = 0;

void expect(bool condition, const char* message) {
  if (condition) return;
  std::fprintf(stderr, "FAIL: %s\n", message);
  failures += 1;
}

pid_t spawn_suspended(const char* path, char* const argv[]) {
  posix_spawnattr_t attributes;
  if (posix_spawnattr_init(&attributes) != 0) return -1;
  const short flags = POSIX_SPAWN_START_SUSPENDED | POSIX_SPAWN_CLOEXEC_DEFAULT;
  if (posix_spawnattr_setflags(&attributes, flags) != 0) {
    posix_spawnattr_destroy(&attributes);
    return -1;
  }
  pid_t pid = -1;
  const int status = posix_spawn(&pid, path, nullptr, &attributes, argv, environ);
  posix_spawnattr_destroy(&attributes);
  return status == 0 ? pid : -1;
}

zody::cua::round11::LoadedCodeExpectation node_expectation() {
  zody::cua::round11::LoadedCodeExpectation expected;
  expected.identifier = "io.github.zclaudia.zody.cua-helper.node";
  expected.leaf_certificate_sha256 = std::string(64, 'a');
  expected.designated_requirement = "identifier \"io.github.zclaudia.zody.cua-helper.node\"";
  expected.cdhash_hex = std::string(40, 'b');
  expected.require_empty_entitlements = true;
  return expected;
}

void test_identity_failure_does_not_resume() {
  char sleep_arg[] = "5";
  char* argv[] = {const_cast<char*>("/bin/sleep"), sleep_arg, nullptr};
  const pid_t pid = spawn_suspended("/bin/sleep", argv);
  expect(pid > 0, "could not spawn suspended child");
  if (pid <= 0) return;

  SuspendedNodeVerification verification;
  const bool accepted = verify_suspended_node_then_resume(pid, node_expectation(), verification);
  expect(!accepted, "non-Node image accepted");
  expect(!verification.resumed, "identity failure sent SIGCONT");
  expect(verification.reaped, "identity failure did not reap child");
  expect(!verification.reason.empty(), "identity failure reason missing");

  errno = 0;
  int status = 0;
  const pid_t after = waitpid(pid, &status, WNOHANG);
  expect(after == -1 && errno == ECHILD, "child was not reaped exactly once");
}

void test_kill_and_reap_is_bounded() {
  char sleep_arg[] = "5";
  char* argv[] = {const_cast<char*>("/bin/sleep"), sleep_arg, nullptr};
  const pid_t pid = spawn_suspended("/bin/sleep", argv);
  expect(pid > 0, "could not spawn suspended child for kill test");
  if (pid <= 0) return;
  int status = 0;
  bool known = false;
  const bool reaped = kill_and_reap_suspended_node(pid, 2'000, status, known);
  expect(reaped && known, "kill_and_reap did not confirm cleanup");
  expect(WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL, "child was not SIGKILLed");
}

}  // namespace

int main() {
  @autoreleasepool {
    test_identity_failure_does_not_resume();
    test_kill_and_reap_is_bounded();
  }
  if (failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", failures);
    return 1;
  }
  std::printf("session-cell-identity: pass\n");
  return 0;
}
