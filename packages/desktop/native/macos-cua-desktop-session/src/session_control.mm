#include "session_control.h"

#import <CoreFoundation/CoreFoundation.h>

#include <errno.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>
#include <string>

namespace zody::cua::desktop_session {
namespace {

bool is_cf_boolean(id value) {
  return CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

bool exact_keys(NSDictionary* dictionary, NSArray<NSString*>* keys) {
  if (![dictionary isKindOfClass:[NSDictionary class]]) return false;
  if (dictionary.count != keys.count) return false;
  for (NSString* key in keys) {
    if (dictionary[key] == nil) return false;
  }
  return true;
}

bool positive_i32(id value, int32_t& out) {
  if (![value isKindOfClass:[NSNumber class]] || is_cf_boolean(value)) return false;
  const double raw = [static_cast<NSNumber*>(value) doubleValue];
  if (!std::isfinite(raw) || std::floor(raw) != raw || raw < 1 ||
      raw > static_cast<double>(std::numeric_limits<int32_t>::max())) {
    return false;
  }
  out = static_cast<int32_t>(raw);
  return true;
}

bool positive_u32(id value, uint32_t& out) {
  if (![value isKindOfClass:[NSNumber class]] || is_cf_boolean(value)) return false;
  const double raw = [static_cast<NSNumber*>(value) doubleValue];
  if (!std::isfinite(raw) || std::floor(raw) != raw || raw < 1 ||
      raw > static_cast<double>(std::numeric_limits<uint32_t>::max())) {
    return false;
  }
  out = static_cast<uint32_t>(raw);
  return true;
}

bool wait_fd(int fd, short events, int timeout_ms) {
  struct pollfd descriptor {};
  descriptor.fd = fd;
  descriptor.events = events;
  int result = 0;
  do {
    result = poll(&descriptor, 1, timeout_ms);
  } while (result < 0 && errno == EINTR);
  if (result <= 0) return false;
  // 中文原因：entry 退出时 poll 可能只报 POLLHUP；必须继续 recv 观察真实 EOF，
  // 否则 fd3 断开会被当成 timeout，supervisor 无法及时退出。
  return (descriptor.revents & (events | POLLHUP | POLLERR)) != 0;
}

}  // namespace

SessionControlStatus SessionControl::read_frame(int timeout_ms, NSDictionary** frame,
                                                std::string& error) {
  if (frame != nullptr) *frame = nil;
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (true) {
    const size_t newline = buffer_.find('\n');
    if (newline != std::string::npos) {
      std::string line = buffer_.substr(0, newline);
      buffer_.erase(0, newline + 1);
      if (line.empty()) continue;
      if (line.size() > kSessionControlMaxFrameBytes) {
        error = "control frame exceeds bound";
        return SessionControlStatus::Error;
      }
      NSData* data = [NSData dataWithBytes:line.data() length:line.size()];
      NSError* json_error = nil;
      id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&json_error];
      if (parsed == nil || json_error != nil || ![parsed isKindOfClass:[NSDictionary class]]) {
        error = "control frame is not a JSON object";
        return SessionControlStatus::Error;
      }
      if (frame != nullptr) *frame = static_cast<NSDictionary*>(parsed);
      return SessionControlStatus::Frame;
    }
    if (buffer_.size() > kSessionControlMaxBufferBytes) {
      error = "control buffer exceeds bound";
      return SessionControlStatus::Error;
    }
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                               deadline - std::chrono::steady_clock::now())
                               .count();
    if (remaining < 0) return SessionControlStatus::Timeout;
    // timeout 0 也要做一次非阻塞 poll，确保确认等待期间能观察 entry EOF/stop。
    if (!wait_fd(fd_, POLLIN, remaining > 0 ? static_cast<int>(remaining) : 0)) {
      if (errno == EINTR) continue;
      return SessionControlStatus::Timeout;
    }
    char chunk[4096];
    const ssize_t count = recv(fd_, chunk, sizeof(chunk), 0);
    if (count == 0) return SessionControlStatus::Eof;
    if (count < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
      error = std::string("control read failed: ") + std::strerror(errno);
      return SessionControlStatus::Error;
    }
    buffer_.append(chunk, static_cast<size_t>(count));
  }
}

bool SessionControl::write_frame(NSDictionary* frame, std::string& error) {
  if (frame == nil) {
    error = "control frame is nil";
    return false;
  }
  NSError* json_error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:frame
                                                options:NSJSONWritingSortedKeys
                                                  error:&json_error];
  if (data == nil || json_error != nil) {
    error = "control frame serialization failed";
    return false;
  }
  if (data.length + 1 > kSessionControlMaxFrameBytes) {
    error = "control frame exceeds bound";
    return false;
  }
  std::string line(static_cast<const char*>(data.bytes), data.length);
  line.push_back('\n');
  size_t offset = 0;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (offset < line.size()) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                               deadline - std::chrono::steady_clock::now())
                               .count();
    if (remaining <= 0) {
      error = "control write timed out";
      return false;
    }
    if (!wait_fd(fd_, POLLOUT, static_cast<int>(remaining))) {
      error = "control write timed out";
      return false;
    }
    const ssize_t count = send(fd_, line.data() + offset, line.size() - offset, MSG_NOSIGNAL);
    if (count < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
      error = std::string("control write failed: ") + std::strerror(errno);
      return false;
    }
    offset += static_cast<size_t>(count);
  }
  return true;
}

bool parse_capture_request(NSDictionary* frame, CaptureTargetRequest& target, std::string& error) {
  target = CaptureTargetRequest();
  if (!exact_keys(frame, @[ @"type", @"target" ])) {
    error = "capture-request shape invalid";
    return false;
  }
  if (![frame[@"type"] isEqualToString:@"capture-request"]) {
    error = "capture-request type invalid";
    return false;
  }
  NSDictionary* target_frame = frame[@"target"];
  if (!exact_keys(target_frame, @[ @"pid", @"windowId" ]) ||
      !positive_i32(target_frame[@"pid"], target.pid) ||
      !positive_u32(target_frame[@"windowId"], target.window_id)) {
    error = "capture-request target invalid";
    return false;
  }
  return true;
}

bool is_stop_frame(NSDictionary* frame) {
  return exact_keys(frame, @[ @"type" ]) &&
         [frame[@"type"] isKindOfClass:[NSString class]] &&
         [frame[@"type"] isEqualToString:@"stop"];
}

bool parse_fatal_frame(NSDictionary* frame, std::string& reason) {
  reason.clear();
  // 中文原因：entry 在 Node 层捕获的 uncaughtException/unhandledRejection 必须
  // 显式报告给 native；否则 child 以 0 退出会把运行时失败伪装成正常关闭。
  if (!exact_keys(frame, @[ @"type", @"reason" ])) return false;
  if (![frame[@"type"] isKindOfClass:[NSString class]] ||
      ![frame[@"type"] isEqualToString:@"fatal"]) {
    return false;
  }
  id raw_reason = frame[@"reason"];
  if (![raw_reason isKindOfClass:[NSString class]]) return false;
  NSData* data = [static_cast<NSString*>(raw_reason)
      dataUsingEncoding:NSUTF8StringEncoding
      allowLossyConversion:NO];
  if (data == nil || data.length == 0 || data.length > 4096) return false;
  reason.assign(static_cast<const char*>(data.bytes), data.length);
  for (unsigned char byte : reason) {
    if (byte < 0x20 || byte == 0x7f) return false;
  }
  return true;
}

}  // namespace zody::cua::desktop_session
