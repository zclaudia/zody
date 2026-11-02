#pragma once

#include <sys/types.h>

#include <string>

namespace zody::cua::round11 {

// 固定 /tmp 机器域，只按有效 UID 命名，不接受 workspace/data-root/命令行覆盖。
std::string machine_lease_path();

struct MachineLeaseResult {
  enum class Status {
    Acquired,
    Busy,
    Invalid,
  };

  Status status = Status::Invalid;
  int error_number = 0;
  std::string reason;
  dev_t device = 0;
  ino_t inode = 0;

  bool acquired() const { return status == Status::Acquired; }
};

// 进程内唯一 owner：取得后保持 fd 打开，析构只 flock(LOCK_UN)+close，
// 永不 unlink 锁文件。进程退出由内核释放 flock；没有超时窃取路径。
class MachineLease {
 public:
  MachineLease() = default;
  ~MachineLease();
  MachineLease(const MachineLease&) = delete;
  MachineLease& operator=(const MachineLease&) = delete;
  MachineLease(MachineLease&& other) noexcept;
  MachineLease& operator=(MachineLease&& other) noexcept;

  MachineLeaseResult acquire();
  bool held() const { return fd_ >= 0; }
  void release();

 private:
  int fd_ = -1;
};

}  // namespace zody::cua::round11
