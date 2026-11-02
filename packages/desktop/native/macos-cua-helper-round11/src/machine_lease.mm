#include "machine_lease.h"

#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <string>
#include <utility>

namespace zody::cua::round11 {
namespace {

MachineLeaseResult invalid(int error_number, std::string reason) {
  MachineLeaseResult result;
  result.status = MachineLeaseResult::Status::Invalid;
  result.error_number = error_number;
  result.reason = std::move(reason);
  return result;
}

// 中文原因：锁的信任不能只看打开后的 fd。路径必须先阻止 symlink，再把
// lstat 的 dev/ino/uid/mode/nlink 与 fstat 对齐，避免持有被替换的 inode。
bool validate_open_file(int fd, const std::string& path, MachineLeaseResult& result) {
  struct stat opened {};
  if (fstat(fd, &opened) != 0) {
    result = invalid(errno, std::string("fstat failed: ") + std::strerror(errno));
    return false;
  }
  if (!S_ISREG(opened.st_mode)) {
    result = invalid(EINVAL, "machine lease is not a regular file");
    return false;
  }
  if (opened.st_uid != geteuid()) {
    result = invalid(EPERM, "machine lease is not owned by the effective uid");
    return false;
  }
  if ((opened.st_mode & 0777) != 0600) {
    result = invalid(EPERM, "machine lease mode must be exactly 0600");
    return false;
  }
  if (opened.st_nlink != 1) {
    result = invalid(EPERM, "machine lease link count must be exactly one");
    return false;
  }

  struct stat linked {};
  if (lstat(path.c_str(), &linked) != 0) {
    result = invalid(errno, std::string("lstat failed: ") + std::strerror(errno));
    return false;
  }
  if (!S_ISREG(linked.st_mode) || linked.st_dev != opened.st_dev ||
      linked.st_ino != opened.st_ino) {
    result = invalid(EPERM, "machine lease path was replaced after open");
    return false;
  }
  if (linked.st_uid != geteuid() || (linked.st_mode & 0777) != 0600 ||
      linked.st_nlink != 1) {
    result = invalid(EPERM, "machine lease path ownership or mode changed");
    return false;
  }
  result.device = opened.st_dev;
  result.inode = opened.st_ino;
  return true;
}

}  // namespace

std::string machine_lease_path() {
  return "/tmp/io.github.zclaudia.zody.cua.machine." + std::to_string(geteuid()) + ".lock";
}

MachineLease::~MachineLease() { release(); }

MachineLease::MachineLease(MachineLease&& other) noexcept : fd_(other.fd_) {
  other.fd_ = -1;
}

MachineLease& MachineLease::operator=(MachineLease&& other) noexcept {
  if (this != &other) {
    release();
    fd_ = other.fd_;
    other.fd_ = -1;
  }
  return *this;
}

void MachineLease::release() {
  if (fd_ < 0) return;
  // 只释放本进程的 flock；锁 inode 保留，供下一次按同一路径/同一 inode 竞争。
  (void)flock(fd_, LOCK_UN);
  close(fd_);
  fd_ = -1;
}

MachineLeaseResult MachineLease::acquire() {
  if (fd_ >= 0) {
    MachineLeaseResult result;
    result.status = MachineLeaseResult::Status::Acquired;
    return result;
  }
  const std::string path = machine_lease_path();
  const int fd = open(path.c_str(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) {
    return invalid(errno, std::string("open machine lease failed: ") + std::strerror(errno));
  }

  MachineLeaseResult observed;
  if (!validate_open_file(fd, path, observed)) {
    close(fd);
    return observed;
  }

  if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    const int error_number = errno;
    close(fd);
    if (error_number == EWOULDBLOCK || error_number == EAGAIN) {
      MachineLeaseResult result;
      result.status = MachineLeaseResult::Status::Busy;
      result.error_number = error_number;
      result.reason = "machine lease is held by another process";
      result.device = observed.device;
      result.inode = observed.inode;
      return result;
    }
    return invalid(error_number, std::string("flock failed: ") + std::strerror(error_number));
  }

  // 取得 flock 后再次核验路径仍指向同一 inode，防止 open 与 flock 之间替换。
  MachineLeaseResult after;
  if (!validate_open_file(fd, path, after)) {
    (void)flock(fd, LOCK_UN);
    close(fd);
    return after;
  }

  fd_ = fd;
  MachineLeaseResult result;
  result.status = MachineLeaseResult::Status::Acquired;
  result.device = after.device;
  result.inode = after.inode;
  return result;
}

}  // namespace zody::cua::round11
