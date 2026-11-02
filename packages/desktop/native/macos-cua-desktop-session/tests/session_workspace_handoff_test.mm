#import <Foundation/Foundation.h>

#include <fcntl.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "session_workspace_handoff.h"

namespace {

int failures = 0;

void expect(bool condition, const char* message) {
  if (condition) return;
  std::fprintf(stderr, "FAIL: %s\n", message);
  failures += 1;
}

std::string object_json(NSDictionary* object) {
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:object
                                                options:NSJSONWritingSortedKeys
                                                  error:&error];
  if (data == nil || error != nil) return "";
  return std::string(static_cast<const char*>(data.bytes), data.length);
}

void test_context_round_trip() {
  using namespace zody::cua::desktop_session;
  const std::string nonce = workspace_nonce();
  expect(workspace_nonce_valid(nonce), "generated nonce rejected");
  expect(!workspace_nonce_valid("not-a-nonce"), "malformed nonce accepted");

  WorkspaceContext source;
  source.entry_name = "host-entry.mjs";
  source.nonce = nonce;
  source.cwd = "/tmp";
  source.env = {"PATH=/usr/bin:/bin", "CUSTOM_VALUE=a=b"};
  source.fd_count = 4;
  const std::string json = workspace_context_json(source);
  expect(!json.empty(), "workspace context serialization failed");

  WorkspaceContext parsed;
  std::string error;
  expect(parse_workspace_context_json(json, source.entry_name, nonce, parsed, error),
         "valid workspace context rejected");
  expect(parsed.entry_name == source.entry_name && parsed.nonce == nonce &&
             parsed.cwd == source.cwd && parsed.env == source.env,
         "workspace context round trip mismatch");
  expect(parsed.fd_count == 4, "workspace fd count round trip mismatch");
}

void test_context_rejections() {
  using namespace zody::cua::desktop_session;
  const std::string nonce = std::string(32, 'a');
  const NSDictionary* base = @{
    @"schemaVersion" : @1,
    @"role" : @"workspace-child",
    @"entryName" : @"host-entry.mjs",
    @"nonce" : [NSString stringWithUTF8String:nonce.c_str()],
    @"cwd" : @"/tmp",
    @"env" : @[ @"PATH=/bin" ],
    @"fdCount" : @4,
  };

  WorkspaceContext parsed;
  std::string error;
  const bool base_parsed = parse_workspace_context_json(object_json((NSDictionary*)base),
                                                       "host-entry.mjs", nonce, parsed, error);
  expect(base_parsed, "valid context unexpectedly rejected before malformed check");
  if (!base_parsed) std::fprintf(stderr, "base context error: %s\n", error.c_str());

  NSMutableDictionary* blocked = [base mutableCopy];
  blocked[@"env"] = @[ @"DYLD_INSERT_LIBRARIES=/tmp/inject.dylib" ];
  expect(!parse_workspace_context_json(object_json(blocked), "host-entry.mjs", nonce, parsed,
                                       error),
         "blocked environment variable accepted");

  NSMutableDictionary* extra = [base mutableCopy];
  extra[@"extra"] = @YES;
  expect(!parse_workspace_context_json(object_json(extra), "host-entry.mjs", nonce, parsed, error),
         "extra context key accepted");

  NSMutableDictionary* boolean_version = [base mutableCopy];
  boolean_version[@"schemaVersion"] = @YES;
  expect(!parse_workspace_context_json(object_json(boolean_version), "host-entry.mjs", nonce,
                                       parsed, error),
         "boolean schemaVersion accepted");

  NSMutableDictionary* wrong_nonce = [base mutableCopy];
  wrong_nonce[@"nonce"] = [NSString stringWithUTF8String:std::string(32, 'b').c_str()];
  expect(!parse_workspace_context_json(object_json(wrong_nonce), "host-entry.mjs", nonce, parsed,
                                       error),
         "wrong nonce association accepted");

  NSMutableDictionary* bad_env_shape = [base mutableCopy];
  bad_env_shape[@"env"] = @[ @42 ];
  expect(!parse_workspace_context_json(object_json(bad_env_shape), "host-entry.mjs", nonce, parsed,
                                       error),
         "non-string environment entry accepted");
}

void test_bridge_counts() {
  using namespace zody::cua::desktop_session;
  std::string error;
  std::vector<int> host_fds;
  expect(workspace_bridge_fds_for_entry("host-entry.mjs", 5, -1, -1, host_fds, error),
         "host bridge plan rejected");
  expect(host_fds == std::vector<int>({0, 1, 2, 5}), "host bridge fd order mismatch");

  WorkspaceBridgeFds host_bridge;
  expect(workspace_bridge_fds_from_bundle("host-entry.mjs", host_fds, host_bridge, error),
         "host bridge bundle rejected");
  expect(host_bridge.host_bridge_fd == 5 && host_bridge.cli_input_fd == -1,
         "host bridge bundle assignment mismatch");

  std::vector<int> cli_fds;
  expect(workspace_bridge_fds_for_entry("cli-entry.mjs", -1, 6, 7, cli_fds, error),
         "cli bridge plan rejected");
  expect(cli_fds == std::vector<int>({0, 1, 2, 6, 7}), "cli bridge fd order mismatch");

  WorkspaceBridgeFds cli_bridge;
  expect(workspace_bridge_fds_from_bundle("cli-entry.mjs", cli_fds, cli_bridge, error),
         "cli bridge bundle rejected");
  expect(cli_bridge.cli_input_fd == 6 && cli_bridge.cli_output_fd == 7 &&
             cli_bridge.host_bridge_fd == -1,
         "cli bridge bundle assignment mismatch");

  std::vector<int> invalid;
  expect(!workspace_bridge_fds_for_entry("host-entry.mjs", 5, 6, 7, invalid, error),
         "host entry accepted cli bridge fds");
  expect(!workspace_bridge_fds_from_bundle("host-entry.mjs", cli_fds, host_bridge, error),
         "host entry accepted a five-fd bundle");
}

void test_real_fd_transfer() {
  using namespace zody::cua::desktop_session;
  int channel[2] = {-1, -1};
  int payload[2] = {-1, -1};
  expect(socketpair(AF_UNIX, SOCK_STREAM, 0, channel) == 0, "fd channel socketpair failed");
  expect(socketpair(AF_UNIX, SOCK_STREAM, 0, payload) == 0, "payload socketpair failed");
  if (channel[0] < 0 || payload[0] < 0) return;

  const char byte = 'x';
  expect(write(payload[0], &byte, 1) == 1, "payload write failed");
  std::string error;
  expect(workspace_send_fds(channel[0], {payload[1]}, kWorkspaceFdMarker, error),
         "real fd send failed");
  close(payload[1]);
  payload[1] = -1;

  std::vector<int> received;
  expect(workspace_receive_fds(channel[1], 1, kWorkspaceFdMarker, received, error),
         "real fd receive failed");
  expect(received.size() == 1, "real fd count mismatch");
  if (received.size() == 1) {
    const int flags = fcntl(received[0], F_GETFD, 0);
    expect(flags >= 0 && (flags & FD_CLOEXEC) != 0, "received fd is not CLOEXEC");
    char read_byte = 0;
    expect(read(received[0], &read_byte, 1) == 1 && read_byte == byte,
           "received fd did not preserve payload");
  }
  workspace_close_fds(received);
  close(payload[0]);
  close(channel[0]);
  close(channel[1]);
}

void test_fd_rejections_and_eof() {
  using namespace zody::cua::desktop_session;
  int channel[2] = {-1, -1};
  int payload[2] = {-1, -1};
  expect(socketpair(AF_UNIX, SOCK_STREAM, 0, channel) == 0, "rejection channel failed");
  expect(socketpair(AF_UNIX, SOCK_STREAM, 0, payload) == 0, "rejection payload failed");
  if (channel[0] < 0 || payload[0] < 0) return;

  std::string error;
  expect(workspace_send_fds(channel[0], {payload[1]}, 'X', error),
         "wrong-marker payload send failed");
  std::vector<int> received;
  expect(!workspace_receive_fds(channel[1], 1, kWorkspaceFdMarker, received, error),
         "wrong marker accepted");
  expect(received.empty(), "wrong marker left received fds tracked");

  expect(workspace_send_fds(channel[0], {payload[0], payload[1]}, kWorkspaceFdMarker, error),
         "two-fd payload send failed");
  expect(!workspace_receive_fds(channel[1], 1, kWorkspaceFdMarker, received, error),
         "fd count mismatch accepted");
  expect(received.empty(), "fd count mismatch left received fds tracked");

  close(channel[0]);
  channel[0] = -1;
  expect(!workspace_receive_fds(channel[1], 1, kWorkspaceFdMarker, received, error),
         "EOF before fd bundle accepted");
  expect(received.empty(), "EOF path left received fds tracked");

  close(payload[0]);
  close(payload[1]);
  close(channel[1]);
}

void test_rehome_fds() {
  using namespace zody::cua::desktop_session;
  int payload[2] = {-1, -1};
  expect(socketpair(AF_UNIX, SOCK_STREAM, 0, payload) == 0, "rehome payload failed");
  if (payload[0] < 0) return;
  const char byte = 'r';
  expect(write(payload[0], &byte, 1) == 1, "rehome payload write failed");
  std::vector<int> fds = {payload[1]};
  std::string error;
  expect(workspace_rehome_fds(fds, error), "rehome failed");
  expect(fds.size() == 1 && fds[0] >= 3, "rehome did not move fd above stdio");
  expect(fcntl(payload[1], F_GETFD, 0) == -1 && errno == EBADF,
         "rehome left the original fd open");
  char read_byte = 0;
  expect(read(fds[0], &read_byte, 1) == 1 && read_byte == byte, "rehome lost payload");
  workspace_close_fds(fds);
  close(payload[0]);

  std::vector<int> invalid = {-1};
  expect(!workspace_rehome_fds(invalid, error), "rehome accepted a closed descriptor");
  expect(invalid.empty(), "rehome failure left fds tracked");
}

void test_status_requires_frame() {
  using namespace zody::cua::desktop_session;
  int code = -1;
  std::string error;
  const std::string status = workspace_child_exit_json(2);
  expect(!status.empty() && parse_workspace_child_exit_json(status, code, error) && code == 2,
         "valid child status rejected");
  code = -1;
  expect(!parse_workspace_child_exit_json("", code, error), "empty child status accepted");
  expect(!parse_workspace_child_exit_json(R"({"schemaVersion":1,"type":"workspace-child-exit"})",
                                          code, error),
         "status without code accepted");
}

}  // namespace

int main() {
  @autoreleasepool {
    test_context_round_trip();
    test_context_rejections();
    test_bridge_counts();
    test_real_fd_transfer();
    test_fd_rejections_and_eof();
    test_rehome_fds();
    test_status_requires_frame();
  }
  if (failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", failures);
    return 1;
  }
  std::printf("ok session-workspace-handoff\n");
  return 0;
}
