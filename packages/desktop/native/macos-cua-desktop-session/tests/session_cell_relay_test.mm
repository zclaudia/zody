#import <Foundation/Foundation.h>

#include <fcntl.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>

#include "session_cell_relay.h"

namespace {

using zody::cua::desktop_session::CellRelayLimits;
using zody::cua::desktop_session::CellRelayOutcome;
using zody::cua::desktop_session::relay_cell_streams;

int failures = 0;

void expect(bool condition, const char* message) {
  if (condition) return;
  std::fprintf(stderr, "FAIL: %s\n", message);
  failures += 1;
}

void make_nonblocking(int fd) {
  const int flags = fcntl(fd, F_GETFL, 0);
  (void)fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

void close_fd(int& fd) {
  if (fd >= 0) close(fd);
  fd = -1;
}

struct Fds {
  int client[2] = {-1, -1};
  int request[2] = {-1, -1};
  int response[2] = {-1, -1};
  ~Fds() {
    for (int& fd : client) close_fd(fd);
    for (int& fd : request) close_fd(fd);
    for (int& fd : response) close_fd(fd);
  }
};

bool open_fds(Fds& fds) {
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, fds.client) != 0) return false;
  if (pipe(fds.request) != 0) return false;
  if (pipe(fds.response) != 0) return false;
  make_nonblocking(fds.client[1]);
  make_nonblocking(fds.request[1]);
  make_nonblocking(fds.response[0]);
  return true;
}

bool wait_done(const std::atomic<bool>& done, int timeout_ms) {
  for (int elapsed = 0; elapsed < timeout_ms; elapsed += 20) {
    if (done.load(std::memory_order_acquire)) return true;
    usleep(20'000);
  }
  return done.load(std::memory_order_acquire);
}

void test_client_eof_aborts_busy_cell() {
  Fds fds;
  expect(open_fds(fds), "client eof: could not create fds");
  std::atomic<bool> stop{false};
  std::atomic<bool> done{false};
  CellRelayOutcome outcome = CellRelayOutcome::Completed;
  std::string error;
  std::thread relay([&] {
    CellRelayLimits limits;
    limits.request_max_bytes = 1024;
    limits.response_max_bytes = 1024;
    limits.timeout_ms = 5'000;
    outcome = relay_cell_streams(fds.client[1], fds.request[1], fds.response[0], limits, stop,
                                 error);
    done.store(true, std::memory_order_release);
  });
  const char request_bytes[] = "req";
  (void)write(fds.client[0], request_bytes, sizeof(request_bytes) - 1);
  (void)shutdown(fds.client[0], SHUT_WR);
  // respond 端保持打开模拟忙 cell / 后代继承 fd4：旧实现会继续 poll 而不退出。
  if (!wait_done(done, 2'000)) {
    stop.store(true, std::memory_order_release);
    expect(false, "client eof: relay did not settle promptly");
  }
  relay.join();
  expect(outcome == CellRelayOutcome::ClientEof, "client eof did not abort relay");
}

void test_response_and_request_bounds_are_enforced() {
  {
    Fds fds;
    expect(open_fds(fds), "response bound: could not create fds");
    std::atomic<bool> stop{false};
    std::atomic<bool> done{false};
    CellRelayOutcome outcome = CellRelayOutcome::Completed;
    std::string error;
    std::thread relay([&] {
      CellRelayLimits limits;
      limits.request_max_bytes = 1024;
      limits.response_max_bytes = 64;
      limits.timeout_ms = 5'000;
      outcome = relay_cell_streams(fds.client[1], fds.request[1], fds.response[0], limits, stop,
                                   error);
      done.store(true, std::memory_order_release);
    });
    const char request_bytes[] = "req";
    (void)write(fds.client[0], request_bytes, sizeof(request_bytes) - 1);
    const std::string large(128, 'r');
    (void)write(fds.response[1], large.data(), large.size());
    if (!wait_done(done, 2'000)) {
      stop.store(true, std::memory_order_release);
      expect(false, "response bound: relay did not settle promptly");
    }
    relay.join();
    expect(outcome == CellRelayOutcome::ResponseBoundExceeded,
           "oversized response not rejected");
  }
  {
    Fds fds;
    expect(open_fds(fds), "request bound: could not create fds");
    std::atomic<bool> stop{false};
    std::atomic<bool> done{false};
    CellRelayOutcome outcome = CellRelayOutcome::Completed;
    std::string error;
    std::thread relay([&] {
      CellRelayLimits limits;
      limits.request_max_bytes = 8;
      limits.response_max_bytes = 1024;
      limits.timeout_ms = 5'000;
      outcome = relay_cell_streams(fds.client[1], fds.request[1], fds.response[0], limits, stop,
                                   error);
      done.store(true, std::memory_order_release);
    });
    const std::string large(32, 'q');
    (void)write(fds.client[0], large.data(), large.size());
    if (!wait_done(done, 2'000)) {
      stop.store(true, std::memory_order_release);
      expect(false, "request bound: relay did not settle promptly");
    }
    relay.join();
    expect(outcome == CellRelayOutcome::RequestBoundExceeded, "oversized request not rejected");
  }
}

void test_total_deadline_bounds_descendant_fd4() {
  Fds fds;
  expect(open_fds(fds), "timeout: could not create fds");
  std::atomic<bool> stop{false};
  std::atomic<bool> done{false};
  CellRelayOutcome outcome = CellRelayOutcome::Completed;
  std::string error;
  std::thread relay([&] {
    CellRelayLimits limits;
    limits.request_max_bytes = 1024;
    limits.response_max_bytes = 1024;
    limits.timeout_ms = 200;
    outcome = relay_cell_streams(fds.client[1], fds.request[1], fds.response[0], limits, stop,
                                 error);
    done.store(true, std::memory_order_release);
  });
  // client 不 EOF，response 写端保持打开：只有总 deadline 能让 relay 有界结束。
  if (!wait_done(done, 2'000)) {
    stop.store(true, std::memory_order_release);
    expect(false, "timeout: relay did not settle");
  }
  relay.join();
  expect(outcome == CellRelayOutcome::TimedOut, "relay deadline did not abort");
}

void test_extra_frames_are_rejected() {
  {
    Fds fds;
    expect(open_fds(fds), "extra response: could not create fds");
    std::atomic<bool> stop{false};
    std::atomic<bool> done{false};
    CellRelayOutcome outcome = CellRelayOutcome::Completed;
    std::string error;
    std::thread relay([&] {
      CellRelayLimits limits;
      limits.request_max_bytes = 1024;
      limits.response_max_bytes = 1024;
      limits.timeout_ms = 5'000;
      outcome = relay_cell_streams(fds.client[1], fds.request[1], fds.response[0], limits, stop,
                                   error);
      done.store(true, std::memory_order_release);
    });
    const std::string payload = "first\nsecond\n";
    (void)write(fds.response[1], payload.data(), payload.size());
    if (!wait_done(done, 2'000)) {
      stop.store(true, std::memory_order_release);
      expect(false, "extra response: relay did not settle promptly");
    }
    relay.join();
    expect(outcome == CellRelayOutcome::ResponseBoundExceeded,
           "cell sent a second fd4 frame and was not rejected");
  }
  {
    Fds fds;
    expect(open_fds(fds), "extra request: could not create fds");
    std::atomic<bool> stop{false};
    std::atomic<bool> done{false};
    CellRelayOutcome outcome = CellRelayOutcome::Completed;
    std::string error;
    std::thread relay([&] {
      CellRelayLimits limits;
      limits.request_max_bytes = 1024;
      limits.response_max_bytes = 1024;
      limits.timeout_ms = 5'000;
      outcome = relay_cell_streams(fds.client[1], fds.request[1], fds.response[0], limits, stop,
                                   error);
      done.store(true, std::memory_order_release);
    });
    const std::string payload = "a\nb\n";
    (void)write(fds.client[0], payload.data(), payload.size());
    if (!wait_done(done, 2'000)) {
      stop.store(true, std::memory_order_release);
      expect(false, "extra request: relay did not settle promptly");
    }
    relay.join();
    expect(outcome == CellRelayOutcome::RequestBoundExceeded,
           "client sent a second fd3 frame and was not rejected");
  }
}

void test_response_newline_is_counted_within_bound() {
  Fds fds;
  expect(open_fds(fds), "response newline: could not create fds");
  std::atomic<bool> stop{false};
  std::atomic<bool> done{false};
  CellRelayOutcome outcome = CellRelayOutcome::Aborted;
  std::string error;
  std::thread relay([&] {
    CellRelayLimits limits;
    limits.request_max_bytes = 1024;
    limits.response_max_bytes = 8;
    limits.timeout_ms = 5'000;
    outcome = relay_cell_streams(fds.client[1], fds.request[1], fds.response[0], limits, stop,
                                 error);
    done.store(true, std::memory_order_release);
  });
  const std::string response = "1234567\n";
  (void)write(fds.response[1], response.data(), response.size());
  close(fds.response[1]);
  fds.response[1] = -1;
  char seen[16] = {};
  const ssize_t count = read(fds.client[0], seen, sizeof(seen));
  expect(count == static_cast<ssize_t>(response.size()) &&
             std::memcmp(seen, response.data(), response.size()) == 0,
         "response at exact bound was not relayed unchanged");
  if (!wait_done(done, 2'000)) {
    stop.store(true, std::memory_order_release);
    expect(false, "response newline: relay did not settle");
  }
  relay.join();
  expect(outcome == CellRelayOutcome::Completed, "response at exact bound was rejected");
}

void test_normal_completion_flushes_both_streams() {
  Fds fds;
  expect(open_fds(fds), "completion: could not create fds");
  std::atomic<bool> stop{false};
  std::atomic<bool> done{false};
  CellRelayOutcome outcome = CellRelayOutcome::Aborted;
  std::string error;
  std::thread relay([&] {
    CellRelayLimits limits;
    limits.request_max_bytes = 1024;
    limits.response_max_bytes = 1024;
    limits.timeout_ms = 5'000;
    outcome = relay_cell_streams(fds.client[1], fds.request[1], fds.response[0], limits, stop,
                                 error);
    done.store(true, std::memory_order_release);
  });
  const char request_bytes[] = "req";
  (void)write(fds.client[0], request_bytes, sizeof(request_bytes) - 1);
  char seen_request[16] = {};
  const ssize_t request_count = read(fds.request[0], seen_request, sizeof(seen_request));
  expect(request_count == static_cast<ssize_t>(sizeof(request_bytes) - 1) &&
             std::memcmp(seen_request, request_bytes, sizeof(request_bytes) - 1) == 0,
         "request bytes not relayed unchanged");
  const char response_bytes[] = "resp";
  (void)write(fds.response[1], response_bytes, sizeof(response_bytes) - 1);
  close(fds.response[1]);
  fds.response[1] = -1;
  char seen_response[16] = {};
  const ssize_t response_count = read(fds.client[0], seen_response, sizeof(seen_response));
  expect(response_count == static_cast<ssize_t>(sizeof(response_bytes) - 1) &&
             std::memcmp(seen_response, response_bytes, sizeof(response_bytes) - 1) == 0,
         "response bytes not relayed unchanged");
  if (!wait_done(done, 2'000)) {
    stop.store(true, std::memory_order_release);
    expect(false, "completion: relay did not settle");
  }
  relay.join();
  expect(outcome == CellRelayOutcome::Completed, "normal completion not reported");
}

}  // namespace

int main() {
  @autoreleasepool {
    test_client_eof_aborts_busy_cell();
    test_response_and_request_bounds_are_enforced();
    test_total_deadline_bounds_descendant_fd4();
    test_extra_frames_are_rejected();
    test_response_newline_is_counted_within_bound();
    test_normal_completion_flushes_both_streams();
  }
  if (failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", failures);
    return 1;
  }
  std::printf("session-cell-relay: pass\n");
  return 0;
}
