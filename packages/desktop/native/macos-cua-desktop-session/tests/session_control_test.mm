#import <Foundation/Foundation.h>

#include <sys/socket.h>
#include <unistd.h>

#include <cstdio>
#include <string>

#include "session_control.h"

namespace {

using zody::cua::desktop_session::CaptureTargetRequest;
using zody::cua::desktop_session::SessionControl;
using zody::cua::desktop_session::SessionControlStatus;
using zody::cua::desktop_session::is_stop_frame;
using zody::cua::desktop_session::parse_capture_request;
using zody::cua::desktop_session::parse_fatal_frame;

int failures = 0;

void expect(bool condition, const char* message) {
  if (condition) return;
  std::fprintf(stderr, "FAIL: %s\n", message);
  failures += 1;
}

void send_line(int fd, const std::string& line) {
  std::string payload = line + "\n";
  size_t offset = 0;
  while (offset < payload.size()) {
    const ssize_t count = write(fd, payload.data() + offset, payload.size() - offset);
    if (count <= 0) return;
    offset += static_cast<size_t>(count);
  }
}

NSDictionary* read_json(SessionControl& control) {
  NSDictionary* frame = nil;
  std::string error;
  const SessionControlStatus status = control.read_frame(1000, &frame, error);
  expect(status == SessionControlStatus::Frame, "control frame read failed");
  return frame;
}

void test_control() {
  int fds[2] = {-1, -1};
  expect(socketpair(AF_UNIX, SOCK_STREAM, 0, fds) == 0, "socketpair failed");
  if (fds[0] < 0) return;
  SessionControl control(fds[0]);

  send_line(fds[1], R"({"type":"capture-request","target":{"pid":99,"windowId":4242}})");
  NSDictionary* frame = read_json(control);
  CaptureTargetRequest target;
  std::string error;
  expect(parse_capture_request(frame, target, error), "valid capture request rejected");
  expect(target.pid == 99 && target.window_id == 4242, "capture target mismatch");

  send_line(fds[1], R"({"type":"stop"})");
  frame = read_json(control);
  expect(is_stop_frame(frame), "stop frame rejected");

  send_line(fds[1], R"({"type":"capture-request","target":{"pid":99}})");
  frame = read_json(control);
  expect(!parse_capture_request(frame, target, error), "incomplete target accepted");

  send_line(fds[1], R"({"type":"capture-request","target":{"pid":true,"windowId":4242}})");
  frame = read_json(control);
  expect(!parse_capture_request(frame, target, error), "boolean pid accepted");

  send_line(fds[1], R"({"type":"capture-request","target":{"pid":1e300,"windowId":4242}})");
  frame = read_json(control);
  expect(!parse_capture_request(frame, target, error), "out-of-range pid accepted");

  send_line(fds[1], R"({"type":"capture-request","target":{"pid":2147483648,"windowId":4242}})");
  frame = read_json(control);
  expect(!parse_capture_request(frame, target, error), "i32 overflow pid accepted");

  send_line(fds[1], R"({"type":"capture-request","target":{"pid":99,"windowId":4294967296}})");
  frame = read_json(control);
  expect(!parse_capture_request(frame, target, error), "u32 overflow window accepted");

  send_line(fds[1], R"({"type":"capture-request","target":{"pid":99.5,"windowId":4242}})");
  frame = read_json(control);
  expect(!parse_capture_request(frame, target, error), "fractional pid accepted");

  send_line(fds[1], R"({"type":"other"})");
  frame = read_json(control);
  expect(!is_stop_frame(frame), "unknown frame treated as stop");

  send_line(fds[1], R"({"type":"fatal","reason":"unhandled-rejection: boom"})");
  frame = read_json(control);
  std::string fatal_reason;
  expect(parse_fatal_frame(frame, fatal_reason), "valid fatal frame rejected");
  expect(fatal_reason == "unhandled-rejection: boom", "fatal reason mismatch");

  send_line(fds[1], R"({"type":"fatal","reason":"line\nbreak"})");
  frame = read_json(control);
  expect(!parse_fatal_frame(frame, fatal_reason), "control character fatal reason accepted");

  send_line(fds[1], R"({"type":"fatal","reason":99})");
  frame = read_json(control);
  expect(!parse_fatal_frame(frame, fatal_reason), "non-string fatal reason accepted");

  NSError* json_error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:@{@"type" : @"session-ready"}
                                                options:NSJSONWritingSortedKeys
                                                  error:&json_error];
  expect(data != nil && json_error == nil, "ready serialization failed");
  expect(control.write_frame(@{@"type" : @"session-ready"}, error), "write_frame failed");
  char buffer[512] = {0};
  const ssize_t count = read(fds[1], buffer, sizeof(buffer) - 1);
  expect(count > 0 && std::string(buffer).find("session-ready") != std::string::npos,
         "written frame missing");

  close(fds[1]);
  close(fds[0]);
}

}  // namespace

int main() {
  @autoreleasepool {
    test_control();
  }
  if (failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", failures);
    return 1;
  }
  std::printf("ok session-control\n");
  return 0;
}
