// Stop regression harness for the derived capture_owner.
//
// The visual ABI is deterministic and fake. The authority client, machine
// lease and capture_owner are the real derived sources. This test proves the
// process-local Stop paths; it does not claim ScreenCaptureKit was cancelled
// or that the OS callback thread returned.

#import <Foundation/Foundation.h>

#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "authority_client.h"
#include "capture_owner.h"
#include "cua_r11_visual.h"
#include "machine_lease.h"

namespace {

using zody::cua::round11::AuthorityClient;
using zody::cua::round11::CaptureOutcome;
using zody::cua::round11::CaptureRequestContext;
using zody::cua::round11::MachineLease;

constexpr uint32_t kWindowId = 77;
constexpr int32_t kPid = 4242;
constexpr int32_t kLayer = 0;
constexpr double kX = 10;
constexpr double kY = 20;
constexpr double kWidth = 300;
constexpr double kHeight = 200;

// A valid 1x1 PNG; only the signature and IHDR dimensions are inspected by
// capture_owner before the file is written.
const uint8_t kOnePixelPng[] = {
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00,
    0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xff, 0x1f, 0x00,
    0x05, 0xfe, 0x02, 0xfe, 0xa7, 0x35, 0x81, 0x84, 0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
};

enum class Scenario {
  Success,
  RevokeBeforeFirstCheck,
  RevokeBeforePublish,
  RevokeAfterPublish,
  LateFrameAfterStop,
  CallbackReleaseUnknown,
};

struct TestState {
  std::mutex mutex;
  std::condition_variable changed;
  bool canceled = false;
  bool frame_ready = false;
  bool take_called = false;
  bool resources_released = false;
  bool held_for_gate = false;
  int wait_status = CUA_R11_VISUAL_OK;
  uint64_t operation_id = 0;
  cua_r11_visual_admit_fn admit = nullptr;
  void* context = nullptr;
  cua_r11_visual_request request{};
};

std::atomic<int> g_visual_start_calls{0};
std::atomic<int> g_os_capture_calls{0};
std::atomic<int> g_take_calls{0};
std::atomic<int> g_cancel_calls{0};
std::atomic<bool> g_cancel_seen_before_wait{false};
std::mutex g_server_write_mutex;
int g_server_fd = -1;
std::function<void()> g_request_stop;
TestState* g_active_state = nullptr;
Scenario g_scenario = Scenario::Success;

void write_line(int fd, const std::string& line) {
  std::lock_guard<std::mutex> lock(g_server_write_mutex);
  std::string bytes = line + "\n";
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t count = send(fd, bytes.data() + offset, bytes.size() - offset, 0);
    if (count < 0) {
      if (errno == EINTR) continue;
      return;
    }
    offset += static_cast<size_t>(count);
  }
}

std::string request_id(NSDictionary* frame) {
  id value = frame[@"requestId"];
  return [value isKindOfClass:[NSString class]]
             ? std::string([static_cast<NSString*>(value) UTF8String])
             : std::string();
}

class AuthorityServer {
 public:
  explicit AuthorityServer(Scenario scenario) : scenario_(scenario) {
    int fds[2] = {-1, -1};
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, fds) != 0) {
      std::perror("socketpair");
      std::exit(2);
    }
    client_fd_ = fds[0];
    server_fd_ = fds[1];
    g_server_fd = server_fd_;
    thread_ = std::thread([this] { run(); });
  }

  ~AuthorityServer() {
    if (server_fd_ >= 0) {
      shutdown(server_fd_, SHUT_RDWR);
      close(server_fd_);
      server_fd_ = -1;
    }
    if (thread_.joinable()) thread_.join();
  }

  int client_fd() const { return client_fd_; }

  void release_client_fd() { client_fd_ = -1; }

 private:
  void run() {
    std::string buffer;
    char chunk[4096];
    int checks = 0;
    bool revoked = false;
    while (true) {
      const ssize_t count = recv(server_fd_, chunk, sizeof(chunk), 0);
      if (count <= 0) break;
      buffer.append(chunk, static_cast<size_t>(count));
      size_t newline = buffer.find('\n');
      while (newline != std::string::npos) {
        std::string line = buffer.substr(0, newline);
        buffer.erase(0, newline + 1);
        if (!line.empty()) {
          NSData* data = [NSData dataWithBytes:line.data() length:line.size()];
          NSError* error = nil;
          id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
          if (![parsed isKindOfClass:[NSDictionary class]]) continue;
          NSDictionary* frame = static_cast<NSDictionary*>(parsed);
          const std::string method = [frame[@"method"] isKindOfClass:[NSString class]]
                                         ? std::string([frame[@"method"] UTF8String])
                                         : std::string();
          const std::string id = request_id(frame);
          if (method != "check") continue;
          ++checks;
          const bool revoke_now = !revoked &&
              ((scenario_ == Scenario::RevokeBeforeFirstCheck && checks == 1) ||
               (scenario_ == Scenario::RevokeBeforePublish && checks == 2));
          if (revoke_now) {
            // Latch the authority status: once revoked, every later check must
            // keep observing revoked instead of reverting to candidate.
            revoked = true;
            write_line(server_fd_, "{\"method\":\"revoked\"}");
          }
          const char* status = revoked ? "revoked" : "candidate";
          write_line(server_fd_,
                     "{\"requestId\":\"" + id + "\",\"result\":{\"ok\":true,\"projection\":{\"status\":\"" +
                         status + "\"}}}");
        }
        newline = buffer.find('\n');
      }
    }
  }

  Scenario scenario_;
  int client_fd_ = -1;
  int server_fd_ = -1;
  std::thread thread_;
};

void request_stop() {
  if (g_request_stop) g_request_stop();
}

}  // namespace

extern "C" bool CGPreflightScreenCaptureAccess(void) { return true; }

extern "C" cua_r11_visual_operation* cua_r11_visual_start(
    const cua_r11_visual_request* request, cua_r11_visual_admit_fn admit, void* context) {
  g_visual_start_calls.fetch_add(1);
  if (request == nullptr || admit == nullptr) return nullptr;
  const int32_t decision = admit(context, 1, CUA_R11_VISUAL_CHECK_START, request->window_id,
                                 request->pid, request->layer, request->x, request->y,
                                 request->width, request->height);
  if (decision != 0) return nullptr;
  g_os_capture_calls.fetch_add(1);
  auto* state = new TestState();
  state->operation_id = 1;
  state->admit = admit;
  state->context = context;
  state->request = *request;
  state->wait_status = g_scenario == Scenario::CallbackReleaseUnknown
                           ? CUA_R11_VISUAL_CANCELED
                           : CUA_R11_VISUAL_OK;
  g_active_state = state;
  if (g_scenario == Scenario::RevokeBeforePublish) {
    // Allocate the fake operation first, then force one real AuthorityClient
    // reader roundtrip while capture_owner has not published the pointer yet.
    // The server latches revoked, so the owner's stop callback only records the
    // atomic latch; the compensation cancel must happen after start returns.
    (void)admit(context, 1, CUA_R11_VISUAL_CHECK_SWIFT_ADMISSION, request->window_id,
                request->pid, request->layer, request->x, request->y, request->width,
                request->height);
  }
  // Swift emits this only after the real captureImage call has been made.
  admit(context, 1, 3, request->window_id, request->pid, request->layer, request->x,
        request->y, request->width, request->height);
  return reinterpret_cast<cua_r11_visual_operation*>(state);
}

extern "C" int32_t cua_r11_visual_wait(cua_r11_visual_operation* operation) {
  auto* state = reinterpret_cast<TestState*>(operation);
  if (state == nullptr) return CUA_R11_VISUAL_INVALID_ARGUMENT;
  std::unique_lock<std::mutex> lock(state->mutex);
  if (state->canceled) {
    // The pre-publish compensation cancel already closed result reception. The
    // fake callback returns its resources without a frame or take.
    if (g_scenario == Scenario::RevokeBeforePublish) {
      g_cancel_seen_before_wait.store(true);
    }
    state->resources_released = true;
    return CUA_R11_VISUAL_CANCELED;
  }
  if (state->wait_status == CUA_R11_VISUAL_OK) {
    state->frame_ready = g_scenario == Scenario::Success ||
                         g_scenario == Scenario::LateFrameAfterStop;
    lock.unlock();
    if (g_scenario == Scenario::RevokeAfterPublish ||
        g_scenario == Scenario::LateFrameAfterStop) {
      // The test scenario decides whether this is a real completion held by a
      // diagnostic gate, a late frame after Stop, or a normal success.
      request_stop();
      lock.lock();
      state->changed.wait_for(lock, std::chrono::seconds(2),
                              [state] { return state->canceled; });
      lock.unlock();
      if (state->canceled) {
        // The fake callback reports release after the cancellation path.
        state->resources_released = true;
      }
      return g_scenario == Scenario::LateFrameAfterStop ? CUA_R11_VISUAL_OK
                                                        : CUA_R11_VISUAL_CANCELED;
    }
    return CUA_R11_VISUAL_OK;
  }
  state->resources_released = false;
  return CUA_R11_VISUAL_CANCELED;
}

extern "C" int32_t cua_r11_visual_take_png(cua_r11_visual_operation* operation,
                                           uint8_t** out_png, size_t* out_len,
                                           uint32_t* out_width, uint32_t* out_height) {
  auto* state = reinterpret_cast<TestState*>(operation);
  if (state == nullptr || out_png == nullptr || out_len == nullptr || out_width == nullptr ||
      out_height == nullptr) {
    return CUA_R11_VISUAL_INVALID_ARGUMENT;
  }
  g_take_calls.fetch_add(1);
  state->take_called = true;
  std::lock_guard<std::mutex> lock(state->mutex);
  if (state->canceled) return CUA_R11_VISUAL_CANCELED;
  if (!state->frame_ready) return CUA_R11_VISUAL_NOT_READY;
  auto* copy = static_cast<uint8_t*>(std::malloc(sizeof(kOnePixelPng)));
  std::memcpy(copy, kOnePixelPng, sizeof(kOnePixelPng));
  *out_png = copy;
  *out_len = sizeof(kOnePixelPng);
  *out_width = 1;
  *out_height = 1;
  state->resources_released = true;
  return CUA_R11_VISUAL_OK;
}

extern "C" void cua_r11_visual_free_png(uint8_t* png, size_t /*len*/) { std::free(png); }

extern "C" void cua_r11_visual_cancel(cua_r11_visual_operation* operation) {
  auto* state = reinterpret_cast<TestState*>(operation);
  if (state == nullptr) return;
  g_cancel_calls.fetch_add(1);
  std::lock_guard<std::mutex> lock(state->mutex);
  state->canceled = true;
  state->changed.notify_all();
}

extern "C" int32_t cua_r11_visual_callback_resources_released(
    cua_r11_visual_operation* operation) {
  auto* state = reinterpret_cast<TestState*>(operation);
  return state != nullptr && state->resources_released ? 1 : 0;
}

extern "C" int32_t cua_r11_visual_destroy(cua_r11_visual_operation* operation) {
  auto* state = reinterpret_cast<TestState*>(operation);
  if (g_active_state == state) g_active_state = nullptr;
  delete state;
  return CUA_R11_VISUAL_OK;
}

namespace {

struct Harness {
  Scenario scenario;
  std::string output_path;
  AuthorityServer server;
  MachineLease lease;
  AuthorityClient authority;
  CaptureRequestContext context;
  int client_fd;

  explicit Harness(Scenario scenario_value)
      : scenario(scenario_value),
        output_path("/tmp/zcode-stop-capture-" + std::to_string(getpid()) + ".png"),
        server(scenario),
        authority(server.client_fd()) {
    g_scenario = scenario;
    (void)unlink(output_path.c_str());
    server.release_client_fd();
    const auto lease_result = lease.acquire();
    if (!lease_result.acquired()) {
      std::fprintf(stderr, "machine lease unavailable: %s\n", lease_result.reason.c_str());
      std::exit(2);
    }
    context.ref = @{@"test" : @YES};
    context.trace_id = @"trace";
    context.producer_incarnation = @"producer";
    context.run_id = @"run";
    context.turn_id = @"turn";
    context.output_path = [NSString stringWithUTF8String:output_path.c_str()];
    context.window_id = kWindowId;
    context.pid = kPid;
    context.layer = kLayer;
    context.x = kX;
    context.y = kY;
    context.width = kWidth;
    context.height = kHeight;
    g_request_stop = [] { write_line(g_server_fd, "{\"method\":\"revoked\"}"); };
  }

  ~Harness() {
    (void)unlink(output_path.c_str());
    g_request_stop = nullptr;
    g_active_state = nullptr;
  }
};

bool file_exists(const std::string& path) { return access(path.c_str(), F_OK) == 0; }

void expect(bool condition, const char* message) {
  if (!condition) {
    std::fprintf(stderr, "FAIL: %s\n", message);
    std::exit(1);
  }
}

}  // namespace

int main() {
  @autoreleasepool {
    {
      Harness harness(Scenario::RevokeBeforeFirstCheck);
      const CaptureOutcome outcome = zody::cua::round11::capture_once(harness.authority, harness.lease,
                                                                      harness.context);
      expect(outcome.authority_stop ==
                 zody::cua::round11::stop_visual::AuthorityStopFact::OwnerRevoked,
             "revoked-before-start records owner-revoked");
      expect(!outcome.visual_started, "revoked-before-start never publishes visual start");
      expect(g_os_capture_calls.load() == 0, "revoked-before-start never calls OS submit");
      expect(outcome.callback_release ==
                 zody::cua::round11::stop_visual::CallbackReleaseFact::NotStarted,
             "revoked-before-start reports not-started, not actual release");
      expect(!file_exists(harness.output_path), "revoked-before-start writes no frame");
    }

    {
      g_os_capture_calls = 0;
      Harness harness(Scenario::RevokeAfterPublish);
      const CaptureOutcome outcome = zody::cua::round11::capture_once(harness.authority, harness.lease,
                                                                      harness.context);
      expect(outcome.visual_started, "start-publish race publishes visual start");
      expect(outcome.visual_wait_returned, "start-publish race returns from wait");
      expect(outcome.authority_stop ==
                 zody::cua::round11::stop_visual::AuthorityStopFact::OwnerRevoked,
             "start-publish race records owner-revoked");
      expect(outcome.reason == "capture-canceled", "start-publish race reports capture-canceled");
      expect(outcome.callback_release ==
                 zody::cua::round11::stop_visual::CallbackReleaseFact::Released,
             "start-publish race waits for actual callback release");
      expect(outcome.resources_released, "start-publish race releases lease only after callback release");
      expect(!file_exists(harness.output_path), "start-publish race writes no frame");
    }

    {
      g_os_capture_calls = 0;
      g_take_calls = 0;
      g_cancel_calls = 0;
      g_cancel_seen_before_wait = false;
      Harness harness(Scenario::RevokeBeforePublish);
      const CaptureOutcome outcome = zody::cua::round11::capture_once(harness.authority, harness.lease,
                                                                      harness.context);
      expect(outcome.visual_started, "pre-publish revoke still returns the allocated visual operation");
      expect(g_os_capture_calls.load() == 1, "pre-publish revoke reaches one fake capture start");
      expect(g_cancel_calls.load() > 0, "publish path compensates the pre-publish revoke with cancel");
      expect(g_cancel_seen_before_wait.load(), "compensation cancel is observed before wait");
      expect(outcome.authority_stop ==
                 zody::cua::round11::stop_visual::AuthorityStopFact::OwnerRevoked,
             "pre-publish revoke records owner-revoked");
      expect(outcome.reason == "capture-canceled", "pre-publish revoke reports capture-canceled");
      expect(g_take_calls.load() == 0, "pre-publish revoke never takes a frame");
      expect(!file_exists(harness.output_path), "pre-publish revoke writes no frame");
      expect(outcome.callback_release ==
                 zody::cua::round11::stop_visual::CallbackReleaseFact::Released,
             "pre-publish revoke waits for actual callback release");
      expect(outcome.resources_released,
             "pre-publish revoke releases only after callback resources return");
    }

    {
      g_os_capture_calls = 0;
      g_take_calls = 0;
      Harness harness(Scenario::LateFrameAfterStop);
      const CaptureOutcome outcome = zody::cua::round11::capture_once(harness.authority, harness.lease,
                                                                      harness.context);
      expect(outcome.late_frame_dropped, "late frame is marked dropped");
      expect(g_take_calls.load() == 0, "late frame is never taken");
      expect(outcome.reason == "capture-canceled", "late frame reports capture-canceled");
      expect(!file_exists(harness.output_path), "late frame is not delivered");
      expect(outcome.callback_release ==
                 zody::cua::round11::stop_visual::CallbackReleaseFact::Released,
             "late frame still waits for actual callback release");
    }

    {
      g_os_capture_calls = 0;
      Harness harness(Scenario::CallbackReleaseUnknown);
      const CaptureOutcome outcome = zody::cua::round11::capture_once(harness.authority, harness.lease,
                                                                      harness.context);
      expect(!outcome.resources_released, "unknown callback release retains resource debt");
      expect(outcome.callback_release ==
                 zody::cua::round11::stop_visual::CallbackReleaseFact::Unknown,
             "unknown callback release is not reported as released");
      expect(outcome.reason == "visual-resources-not-released",
             "unknown callback release reports explicit failure");
    }

    {
      g_os_capture_calls = 0;
      g_take_calls = 0;
      Harness harness(Scenario::Success);
      const CaptureOutcome outcome = zody::cua::round11::capture_once(harness.authority, harness.lease,
                                                                      harness.context);
      expect(outcome.ok, "normal capture still succeeds");
      expect(outcome.os_submitted, "normal capture observes submit-return");
      expect(outcome.callback_release ==
                 zody::cua::round11::stop_visual::CallbackReleaseFact::Released,
             "normal capture reports actual callback release");
      expect(file_exists(harness.output_path), "normal capture writes the frame");
    }
  }
  std::printf("stop capture_owner tests passed\n");
  return 0;
}
