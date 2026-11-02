#pragma once

#import <Foundation/Foundation.h>

#include <cstdint>
#include <string>

namespace zody::cua::desktop_session {

constexpr size_t kSessionControlMaxFrameBytes = 16 * 1024;
constexpr size_t kSessionControlMaxBufferBytes = 64 * 1024;

struct CaptureTargetRequest {
  int32_t pid = 0;
  uint32_t window_id = 0;
};

enum class SessionControlStatus {
  Frame,
  Timeout,
  Eof,
  Error,
};

// fd3 是 native 与 sealed entry 之间的双工 NDJSON 控制流。首帧由 native 写
// session-ready；此后 entry 只提交有界 capture-request/stop/fatal，不承载身份或授权。
// fatal 只让 native 记录非零退出诊断，不改变 owner/lease，也不能伪造 capture 成功。
class SessionControl {
 public:
  explicit SessionControl(int fd) : fd_(fd) {}
  SessionControl(const SessionControl&) = delete;
  SessionControl& operator=(const SessionControl&) = delete;

  SessionControlStatus read_frame(int timeout_ms, NSDictionary** frame, std::string& error);
  bool write_frame(NSDictionary* frame, std::string& error);
  bool has_buffered_bytes() const { return !buffer_.empty(); }

 private:
  int fd_;
  std::string buffer_;
};

bool parse_capture_request(NSDictionary* frame, CaptureTargetRequest& target, std::string& error);
bool is_stop_frame(NSDictionary* frame);
bool parse_fatal_frame(NSDictionary* frame, std::string& reason);

}  // namespace zody::cua::desktop_session
