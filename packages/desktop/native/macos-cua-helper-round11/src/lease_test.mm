// 独立测试二进制：真实双进程竞争同一 machine lease 的 holder/probe。
// 该模式不进入生产 Helper main，也不接触 authority、截图或 TCC。

#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>

#include "machine_lease.h"

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: lease-test hold <ms> | probe\n");
    return 64;
  }
  zody::cua::round11::MachineLease lease;
  const zody::cua::round11::MachineLeaseResult result = lease.acquire();
  if (result.status == zody::cua::round11::MachineLeaseResult::Status::Busy) {
    std::printf("{\"status\":\"busy\",\"path\":\"%s\"}\n",
                zody::cua::round11::machine_lease_path().c_str());
    return 2;
  }
  if (!result.acquired()) {
    std::printf("{\"status\":\"invalid\",\"reason\":\"%s\"}\n", result.reason.c_str());
    return 3;
  }

  if (std::strcmp(argv[1], "probe") == 0) {
    std::printf("{\"status\":\"acquired\",\"path\":\"%s\",\"device\":%llu,\"inode\":%llu}\n",
                zody::cua::round11::machine_lease_path().c_str(),
                static_cast<unsigned long long>(result.device),
                static_cast<unsigned long long>(result.inode));
    return 0;
  }
  if (std::strcmp(argv[1], "hold") == 0 && argc == 3) {
    int milliseconds = 0;
    if (std::sscanf(argv[2], "%d", &milliseconds) != 1 || milliseconds < 1 ||
        milliseconds > 60'000) {
      std::fprintf(stderr, "invalid hold duration\n");
      return 64;
    }
    std::printf("{\"status\":\"held\",\"path\":\"%s\",\"pid\":%d}\n",
                zody::cua::round11::machine_lease_path().c_str(), static_cast<int>(getpid()));
    std::fflush(stdout);
    std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
    return 0;
  }
  std::fprintf(stderr, "unknown lease-test mode\n");
  return 64;
}
