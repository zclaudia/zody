#pragma once

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <string>

#include "confirmation.h"
#include "session_launcher.h"

namespace zody::cua::round11 {
class AuthorityClient;
}

namespace zody::cua::desktop_session {

class AuthorityFdReader;
class SessionControl;

// 后台 supervisor：每次真实 tool call 由 entry 建立一条独立 authority 连接。
// native 在该连接上发 bootstrap {}, 从同一 live scope 取得 target，确认后采集，
// 并在资源与 machine lease 都真实释放后提交一次 captureResult。
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
  bool wait_for_decision(uint64_t generation, bool& allowed, std::string& reason);
  bool poll_cancellation(std::string& reason);
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

  std::mutex decision_mutex_;
  std::condition_variable decision_cv_;
  bool decided_ = false;
  bool allowed_ = false;
  std::string decision_reason_;

  int exit_code_ = 0;
  std::string failure_reason_;
};

}  // namespace zody::cua::desktop_session
