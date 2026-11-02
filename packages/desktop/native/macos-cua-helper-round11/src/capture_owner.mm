#include "capture_owner.h"

#import <CommonCrypto/CommonDigest.h>
#import <CoreGraphics/CoreGraphics.h>

#include <fcntl.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <mutex>
#include <string>

#ifdef CUA_R11_HAVE_VISUAL
#include "cua_r11_visual.h"
#endif

namespace zody::cua::round11 {
namespace {

#ifdef CUA_R11_HAVE_VISUAL

constexpr int kCallbackReleaseTimeoutMs = 15'000;

// 中文原因：callback 在 Swift 线程上晚于 wait() 返回，裸指针由主线程赋值/
// reader 线程读会形成 data race 与 destroy 后 cancel UAF。所有 publish、
// cancel、detach、destroy 都在同一 mutex 下完成；未归还的 context 会被隔离
// 而不是释放 stack 内存。
struct CheckpointContext {
  std::mutex mutex;
  cua_r11_visual_operation* operation = nullptr;
  bool detached = false;
  std::atomic<bool> revoked{false};
  std::atomic<uint64_t> observed_operation{0};

  AuthorityClient* authority = nullptr;
  MachineLease* lease = nullptr;
  NSDictionary* ref = nil;
  NSString* trace_id = nil;
  NSString* producer = nil;
  NSString* run_id = nil;
  NSString* turn_id = nil;
  cua_r11_visual_request target{};
};

bool target_matches(const CheckpointContext& context, uint32_t window_id, int32_t pid,
                    int32_t layer, double x, double y, double width, double height) {
  return context.target.window_id == window_id && context.target.pid == pid &&
         context.target.layer == layer && context.target.x == x && context.target.y == y &&
         context.target.width == width && context.target.height == height;
}

bool authority_candidate(AuthorityClient& authority, CheckpointContext& context,
                         std::string& error) {
  NSDictionary* payload = @{
    @"traceId" : context.trace_id,
    @"ref" : context.ref,
    @"producerIncarnation" : context.producer,
    @"runId" : context.run_id,
    @"turnId" : context.turn_id,
  };
  NSDictionary* result = nil;
  if (!authority.request(@"check", payload, &result, error)) return false;
  if (![result[@"ok"] boolValue]) return false;
  NSDictionary* projection = result[@"projection"];
  return [projection[@"status"] isEqualToString:@"candidate"];
}

int32_t checkpoint(void* raw, uint64_t operation_id, uint32_t checkpoint_id, uint32_t window_id,
                   int32_t pid, int32_t layer, double x, double y, double width,
                   double height) {
  auto* context = static_cast<CheckpointContext*>(raw);
  (void)checkpoint_id;
  if (context == nullptr) return 1;
  {
    std::lock_guard<std::mutex> lock(context->mutex);
    if (context->detached || context->revoked.load()) return 1;
    // 中文原因：SwiftAdmission 可能在 cua_start 返回前异步触发，此时 operation
    // 尚未 publish 是合法状态；只要求本次所有 checkpoint 绑定同一个 operationID。
    // 真正 cancel/destroy 的指针仍由同一 mutex 保护。
    uint64_t expected = context->observed_operation.load();
    if (expected == 0) {
      if (operation_id == 0) return 1;
      context->observed_operation.store(operation_id);
    } else if (expected != operation_id) {
      return 1;
    }
  }
  if (!target_matches(*context, window_id, pid, layer, x, y, width, height)) return 1;
  if (context->lease == nullptr || !context->lease->held()) return 1;
  if (context->revoked.load()) return 1;
  std::string error;
  return authority_candidate(*context->authority, *context, error) ? 0 : 1;
}

bool png_dimensions(const uint8_t* png, size_t length, uint32_t& width, uint32_t& height) {
  static const uint8_t signature[8] = {137, 80, 78, 71, 13, 10, 26, 10};
  if (length < 24 || std::memcmp(png, signature, sizeof(signature)) != 0) return false;
  if (std::memcmp(png + 12, "IHDR", 4) != 0) return false;
  width = (static_cast<uint32_t>(png[16]) << 24) | (static_cast<uint32_t>(png[17]) << 16) |
          (static_cast<uint32_t>(png[18]) << 8) | png[19];
  height = (static_cast<uint32_t>(png[20]) << 24) | (static_cast<uint32_t>(png[21]) << 16) |
           (static_cast<uint32_t>(png[22]) << 8) | png[23];
  return width > 0 && height > 0;
}

std::string sha256_bytes(const uint8_t* bytes, size_t length) {
  uint8_t digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes, static_cast<CC_LONG>(length), digest);
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.reserve(sizeof(digest) * 2);
  for (uint8_t byte : digest) {
    out.push_back(hex[(byte >> 4) & 0x0f]);
    out.push_back(hex[byte & 0x0f]);
  }
  return out;
}

bool write_new_file(const std::string& path, const uint8_t* bytes, size_t length,
                    std::string& error) {
  const int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) {
    error = std::string("cannot create PNG: ") + std::strerror(errno);
    return false;
  }
  size_t offset = 0;
  bool ok = true;
  while (offset < length) {
    const ssize_t count = write(fd, bytes + offset, length - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      error = std::string("cannot write PNG: ") + std::strerror(errno);
      ok = false;
      break;
    }
    offset += static_cast<size_t>(count);
  }
  if (ok && fsync(fd) != 0) {
    error = std::string("cannot fsync PNG: ") + std::strerror(errno);
    ok = false;
  }
  close(fd);
  if (!ok) {
    // 中文原因：只写了一半的 PNG 不能留下，否则 supervisor 会把部分文件当
    // 成一次捕获结果。失败路径删除本进程刚创建的路径。
    (void)unlink(path.c_str());
  }
  return ok;
}

bool wait_callback_release(cua_r11_visual_operation* operation, int timeout_ms) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (std::chrono::steady_clock::now() < deadline) {
    if (cua_r11_visual_callback_resources_released(operation) == 1) return true;
    usleep(50'000);
  }
  return cua_r11_visual_callback_resources_released(operation) == 1;
}

#endif  // CUA_R11_HAVE_VISUAL

}  // namespace

CaptureOutcome capture_once(AuthorityClient& authority, MachineLease& lease,
                            const CaptureRequestContext& context) {
  CaptureOutcome outcome;
#ifdef CUA_R11_HAVE_VISUAL
  if (!lease.held()) {
    outcome.reason = "machine-lease-not-held";
    return outcome;
  }
  if (context.output_path == nil || [context.output_path length] == 0 || context.ref == nil ||
      context.trace_id == nil || context.producer_incarnation == nil || context.run_id == nil ||
      context.turn_id == nil) {
    outcome.reason = "capture-context-incomplete";
    return outcome;
  }
  if (!CGPreflightScreenCaptureAccess()) {
    outcome.reason = "tcc-not-authorized";
    return outcome;
  }

  auto state = std::make_shared<CheckpointContext>();
  state->authority = &authority;
  state->lease = &lease;
  state->ref = context.ref;
  state->trace_id = context.trace_id;
  state->producer = context.producer_incarnation;
  state->run_id = context.run_id;
  state->turn_id = context.turn_id;
  state->target.window_id = context.window_id;
  state->target.pid = context.pid;
  state->target.layer = context.layer;
  state->target.x = context.x;
  state->target.y = context.y;
  state->target.width = context.width;
  state->target.height = context.height;

  auto cancel_operation = [state]() {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->revoked.store(true);
    if (state->operation != nullptr && !state->detached) {
      cua_r11_visual_cancel(state->operation);
    }
  };

  if (!authority.start([cancel_operation](const std::string&) { cancel_operation(); },
                       [cancel_operation](const std::string&) { cancel_operation(); },
                       outcome.reason)) {
    return outcome;
  }

  cua_r11_visual_operation* started =
      cua_r11_visual_start(&state->target, checkpoint, state.get());
  if (started == nullptr) {
    // 中文原因：callback 线程可能仍持有 state；shared_ptr 由 authority 的
    // std::function 持有，调用方 close authority 后才会安全释放。
    outcome.reason = "visual-start-denied";
    return outcome;
  }
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->operation = started;
    // start 期间已经观察到 revoke/EOF：发布后必须补 cancel，不能继续等截图。
    if (state->revoked.load()) cua_r11_visual_cancel(started);
  }

  const int32_t wait_status = cua_r11_visual_wait(started);
  uint8_t* png = nullptr;
  size_t png_len = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  if (wait_status == CUA_R11_VISUAL_OK && !state->revoked.load()) {
    const int32_t take_status =
        cua_r11_visual_take_png(started, &png, &png_len, &width, &height);
    if (take_status != CUA_R11_VISUAL_OK || png == nullptr || png_len == 0) {
      outcome.reason = "visual-take-png-failed";
    } else {
      uint32_t header_width = 0;
      uint32_t header_height = 0;
      if (!png_dimensions(png, png_len, header_width, header_height) ||
          header_width != width || header_height != height) {
        outcome.reason = "visual-png-invalid";
      } else if (state->revoked.load()) {
        outcome.reason = "capture-canceled";
      } else {
        std::string check_error;
        if (!authority_candidate(authority, *state, check_error)) {
          // 最后 gate：从 takePNG 到落盘之间观察到撤销，禁止发布晚图。
          outcome.reason = "capture-canceled";
        } else {
          const std::string output_path([context.output_path UTF8String]);
          std::string write_error;
          // 中文原因：authority check 在 mutex 外等待 reader，避免阻塞撤销；
          // 拿到 state mutex 后再检查一次 revoked，并把写文件/commit 放在同一
          // 临界区，撤销事件无法插入“已检查”与“文件可见”之间。
          bool committed = false;
          {
            std::lock_guard<std::mutex> lock(state->mutex);
            if (!state->revoked.load()) {
              if (!write_new_file(output_path, png, png_len, write_error)) {
                outcome.reason = write_error;
              } else {
                outcome.png_sha256 = sha256_bytes(png, png_len);
                outcome.width = width;
                outcome.height = height;
                committed = true;
              }
            }
          }
          if (!committed && outcome.reason.empty()) {
            outcome.reason = "capture-canceled";
          }
        }
      }
    }
  } else if (wait_status == CUA_R11_VISUAL_CANCELED || state->revoked.load()) {
    outcome.reason = "capture-canceled";
  } else {
    outcome.reason = "visual-wait-failed";
  }
  if (png != nullptr) cua_r11_visual_free_png(png, png_len);

  // 资源归还是独立 callback 事实，不能把 wait()/cancel 返回当成已归还。
  const bool released = wait_callback_release(started, kCallbackReleaseTimeoutMs);
  if (!released) {
    // 隔离：保留 operation 与 heap context，不释放仍可能被 callback 使用的
    // 内存；同时调用方会保留 lease/authority 直到进程终止。
    outcome.resources_released = false;
    outcome.ok = false;
    outcome.reason = "visual-resources-not-released";
    return outcome;
  }

  {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->detached = true;
    state->operation = nullptr;
  }
  const int32_t destroy_status = cua_r11_visual_destroy(started);
  if (destroy_status != CUA_R11_VISUAL_OK) {
    outcome.resources_released = false;
    outcome.ok = false;
    outcome.reason = "visual-destroy-pending";
    return outcome;
  }

  if (outcome.reason.empty()) {
    NSDictionary* revoke_result = nil;
    std::string revoke_error;
    NSDictionary* payload = @{@"traceId" : context.trace_id, @"ref" : context.ref};
    if (!authority.request(@"revoke", payload, &revoke_result, revoke_error)) {
      outcome.reason = "authority-revoke-failed";
    } else if (![revoke_result[@"ok"] boolValue] ||
               ![revoke_result[@"revocation"][@"status"] isEqualToString:@"revoked"]) {
      outcome.reason = "authority-revoke-not-confirmed";
    } else {
      outcome.revoked = true;
      outcome.ok = true;
      outcome.reason = "captured-and-revoked";
    }
    if (!outcome.ok && !outcome.png_sha256.empty()) {
      // 仅回滚本次已成功创建的 PNG；写失败/O_EXCL 失败绝不删除既有路径。
      (void)unlink([context.output_path UTF8String]);
    }
  }
#else
  (void)authority;
  (void)lease;
  (void)context;
  outcome.reason = "visual-staticlib-missing";
  outcome.resources_released = false;
#endif
  return outcome;
}

}  // namespace zody::cua::round11
