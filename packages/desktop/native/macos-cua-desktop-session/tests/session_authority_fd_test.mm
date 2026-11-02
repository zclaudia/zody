#import <Foundation/Foundation.h>

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>

#include "authority_client.h"
#include "session_authority_fd.h"

namespace {

int failures = 0;

void expect(bool condition, const char* message) {
  if (condition) return;
  std::fprintf(stderr, "FAIL: %s\n", message);
  failures += 1;
}

bool read_line_with_deadline(int fd, std::string& line) {
  line.clear();
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (std::chrono::steady_clock::now() < deadline) {
    pollfd entry{fd, POLLIN, 0};
    const int ready = poll(&entry, 1, 100);
    if (ready == 0) continue;
    if (ready < 0) return false;
    char chunk[4096];
    const ssize_t count = read(fd, chunk, sizeof(chunk));
    if (count <= 0) return false;
    line.append(chunk, static_cast<size_t>(count));
    if (line.find('\n') != std::string::npos) return true;
  }
  return false;
}

std::string request_id_from(const std::string& line) {
  const std::string marker = "\"requestId\":\"";
  const size_t start = line.find(marker);
  if (start == std::string::npos) return "";
  const size_t value_start = start + marker.size();
  const size_t end = line.find('"', value_start);
  if (end == std::string::npos) return "";
  return line.substr(value_start, end - value_start);
}

void make_nonblocking(int fd) {
  const int flags = fcntl(fd, F_GETFL, 0);
  expect(flags >= 0, "F_GETFL failed");
  if (flags >= 0) expect(fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0, "set O_NONBLOCK failed");
}

void test_blocking_handoff_delayed_response() {
  int fds[2] = {-1, -1};
  expect(socketpair(AF_UNIX, SOCK_STREAM, 0, fds) == 0, "socketpair failed");
  if (fds[0] < 0) return;
  make_nonblocking(fds[0]);

  std::string error;
  expect(zody::cua::desktop_session::make_authority_fd_blocking(fds[0], error),
         "authority fd blocking handoff failed");
  const int flags = fcntl(fds[0], F_GETFL, 0);
  expect(flags >= 0 && (flags & O_NONBLOCK) == 0, "O_NONBLOCK not cleared");

  zody::cua::round11::AuthorityClient client(fds[0]);
  expect(client.start([](const std::string&) {}, [](const std::string&) {}, error),
         "authority client start failed");
  std::thread responder([&] {
    std::string request;
    if (!read_line_with_deadline(fds[1], request)) return;
    const std::string request_id = request_id_from(request);
    if (request_id.empty()) return;
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    const std::string response = "{\"requestId\":\"" + request_id +
                                 "\",\"result\":{\"ok\":true,"
                                 "\"projection\":{\"status\":\"candidate\"}}}\n";
    (void)send(fds[1], response.data(), response.size(), MSG_NOSIGNAL);
  });

  NSDictionary* result = nil;
  const bool ok = client.request(@"check", @{}, &result, error);
  expect(ok, "delayed authority response was rejected");
  expect([result[@"ok"] boolValue], "delayed authority result missing ok");
  expect([result[@"projection"][@"status"] isEqualToString:@"candidate"],
         "delayed authority result missing candidate projection");
  client.close();
  responder.join();
  close(fds[1]);
}

void test_interrupt_wakes_blocking_reader() {
  int fds[2] = {-1, -1};
  expect(socketpair(AF_UNIX, SOCK_STREAM, 0, fds) == 0, "socketpair failed");
  if (fds[0] < 0) return;
  make_nonblocking(fds[0]);
  std::string error;
  expect(zody::cua::desktop_session::make_authority_fd_blocking(fds[0], error),
         "authority fd blocking handoff failed");

  zody::cua::round11::AuthorityClient client(fds[0]);
  std::mutex close_mutex;
  std::string close_reason;
  expect(client.start([](const std::string&) {}, [&](const std::string& reason) {
           std::lock_guard<std::mutex> lock(close_mutex);
           close_reason = reason;
         }, error),
         "authority client start failed");

  bool request_ok = true;
  std::string request_error;
  std::thread requester([&] {
    NSDictionary* result = nil;
    request_ok = client.request(@"check", @{}, &result, request_error);
  });
  std::string request;
  expect(read_line_with_deadline(fds[1], request), "request was not sent");
  client.interrupt();
  requester.join();
  expect(!request_ok, "interrupt did not fail pending request");
  client.close();
  {
    std::lock_guard<std::mutex> lock(close_mutex);
    expect(close_reason == "authority-eof", "interrupt did not close reader with authority-eof");
  }
  close(fds[1]);
}

}  // namespace

int main() {
  @autoreleasepool {
    test_blocking_handoff_delayed_response();
    test_interrupt_wakes_blocking_reader();
  }
  if (failures != 0) return 1;
  std::printf("ok session-authority-fd\n");
  return 0;
}
