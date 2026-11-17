#pragma once
#include <cstdio>
#include <string>
namespace zody::cua::desktop_session {
inline std::string capture_delivery_log_line(const std::string& sha, unsigned width, unsigned height,
                                             size_t bytes, bool released) {
  char suffix[256];
  std::snprintf(suffix, sizeof(suffix), "\",\"width\":%u,\"height\":%u,\"bytes\":%zu,\"resourcesReleased\":true,\"machineLeaseReleased\":%s%s}", width, height, bytes, released ? "true" : "false", released ? "" : ",\"machineLeaseBorrowReturned\":true");
  return "[cua-native] capture-delivered {\"sha256\":\"" + sha + suffix;
}
}
