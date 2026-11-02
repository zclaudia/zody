#pragma once

#import <Foundation/Foundation.h>

#include <atomic>
#include <functional>
#include <mutex>
#include <string>

#include "confirmation.h"
#include "session_binding.h"
#include "session_launcher.h"

namespace zody::cua::round11 {
class AuthorityClient;
}

namespace zody::cua::desktop_session {

class SessionControl;

// authority 双工帧读取器。bootstrap/check 用 request()（固定 kAuthorityIoTimeoutMs
// IO 窗口）；App 内确认用 send()+await_response()：发送仍受写超时约束，等待无固定
// deadline，由响应/连接终止/取消源收口。
class AuthorityFdReader {
 public:
  explicit AuthorityFdReader(int fd, std::string initial_buffer = {});

  bool request(NSString* method, NSDictionary* payload, NSDictionary** result,
               std::string& error);

  // 发送一帧并回传分配的 requestId，不等待响应。confirm 等待循环专用：App 内确认
  // 没有固定 deadline，不能进入 request() 的 IO 窗口。requestId 延续 native-N 单调。
  bool send(NSString* method, NSDictionary* payload, std::string& request_id,
            std::string& error);

  enum class AwaitStatus { Response, Canceled, Timeout };
  struct AwaitFrame {
    AwaitStatus status = AwaitStatus::Timeout;
    NSDictionary* result = nil;
    std::string reason;
  };
  // 读取一行并按 confirm 等待语义分类：requestId 匹配本请求 → Response；
  // revoked/EOF/读错误/坏帧/不匹配帧 → Canceled（与 pollCancel 同一取消分类并锁存
  // canceled_）；片内无完整行 → Timeout，由调用方继续下一片。
  AwaitFrame await_response(const std::string& request_id, int timeout_ms);

  // 等待期间也必须持续处理 owner 失效/EOF；完整 line 被消费后返回 true。
  bool pollCancel(int timeout_ms, std::string& reason);

  bool has_buffered_bytes() const { return !buffer_.empty(); }

 private:
  enum class ReadStatus { Line, Timeout, Eof, Error };
  enum class FieldStatus { Absent, Valid, Invalid };

  // 中文原因：UTF8String 在嵌入 NUL 处截断，会让 "native-1\u0000xxx" 与
  // "native-1" 误匹配。必须按 NSData 长度保留原始字节，并拒绝任何 C0/DEL。
  static FieldStatus string_field(NSDictionary* frame, NSString* key, std::string& out);

  static bool parse_object(const std::string& line, NSDictionary** frame, std::string& error);

  bool send_frame(NSString* method, NSDictionary* payload, const std::string& request_id,
                  std::string& error);

  ReadStatus read_line(int timeout_ms, std::string& line, std::string& error);

  int fd_;
  uint64_t next_request_ = 1;
  std::string buffer_;
  bool canceled_ = false;
  std::string cancel_reason_;
};

// App 内确认等待结果。
enum class AppConfirmStatus { Allowed, Denied, Failed, Canceled };

struct AppConfirmResult {
  AppConfirmStatus status = AppConfirmStatus::Failed;
  std::string reason;
};

using AppConfirmCancelPoll = std::function<bool(std::string& reason)>;

// 发送 method "confirm" 帧并等待 CLI 转达的 App 决定。payload 携带 generation、
// 与 check 帧同源的完整关联字段和 target 展示事实。无固定 deadline：每 250ms 片
// 先轮询取消源（stop_/control），再读一片响应；由响应、连接终止或取消收口。
// Allowed/Denied 对应 {ok:true,allowed:...}；Failed 一律 fail-closed（ok:false 或
// 帧/result shape 非法）；Canceled 携带既有取消 reason。
AppConfirmResult request_app_confirmation(AuthorityFdReader& reader, uint64_t generation,
                                          const SessionBinding& binding,
                                          const AppConfirmCancelPoll& poll_cancel);

// 后台 supervisor：每次真实 tool call 由 entry 建立一条独立 authority 连接。
// native 在该连接上发 bootstrap {}, 从同一 live scope 取得 target，经 confirm 帧
// 请求 App 内确认，决定后采集，并在资源与 machine lease 都真实释放后提交一次
// captureResult。
class SessionSupervisor {
 public:
  SessionSupervisor(SessionLaunch& launch, ConfirmationController& confirmation);
  ~SessionSupervisor();
  SessionSupervisor(const SessionSupervisor&) = delete;
  SessionSupervisor& operator=(const SessionSupervisor&) = delete;

  void run();
  void requestStop(const std::string& reason);
  int exitCode() const { return exit_code_; }
  const std::string& failureReason() const { return failure_reason_; }

 private:
  // 唯一 fd owner：转交给 AuthorityClient 前由本对象关闭，转交后外层不再 close。
  class OwnedFd {
   public:
    explicit OwnedFd(int fd = -1) : fd_(fd) {}
    ~OwnedFd();
    OwnedFd(const OwnedFd&) = delete;
    OwnedFd& operator=(const OwnedFd&) = delete;

    int get() const { return fd_; }
    int release();

   private:
    int fd_;
  };

  bool handle_connection(OwnedFd& connection, std::string& error);
  bool poll_cancellation(std::string& reason);
  bool poll_control_cancellation(std::string& reason);
  // 中文原因：confirm 等待期间 authority fd 的 EOF/revoked 由等待循环自己读取；
  // 取消轮询只观察 stop_ 与 control fd，否则 pollCancel(0) 会抢先消费刚到达的
  // confirm 响应帧并误判为 unexpected-authority-frame。
  bool poll_confirmation_cancellation(std::string& reason);
  std::string classify_control_eof();
  bool is_fatal_exit_reason(const std::string& reason) const;
  void stop_main_loop_once();
  void set_active_fd(int fd);
  void promote_active_authority(zody::cua::round11::AuthorityClient* authority, int fd);
  void clear_active_connection();
  void set_active_generation(uint64_t generation);
  void clear_active_generation(uint64_t generation);
  void markFatal(const std::string& reason);

  SessionLaunch& launch_;
  ConfirmationController& confirmation_;
  std::atomic<bool> stop_{false};
  std::atomic<bool> main_loop_stopped_{false};
  std::mutex stop_mutex_;
  std::string stop_reason_;

  AuthorityFdReader* authority_reader_ = nullptr;
  SessionControl* control_ = nullptr;

  std::mutex active_mutex_;
  int active_fd_ = -1;
  zody::cua::round11::AuthorityClient* active_authority_ = nullptr;
  uint64_t active_generation_ = 0;

  int exit_code_ = 0;
  std::string failure_reason_;
};

}  // namespace zody::cua::desktop_session
