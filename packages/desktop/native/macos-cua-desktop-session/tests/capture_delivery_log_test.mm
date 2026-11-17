#include "capture_delivery_log.h"
#include <cassert>
#include <string>
using namespace zody::cua::desktop_session;
int main() {
  const auto released = capture_delivery_log_line("abcd", 1, 2, 3, true);
  assert(released.find("\"machineLeaseReleased\":true") != std::string::npos);
  assert(released.find("machineLeaseBorrowReturned") == std::string::npos);
  const auto borrowed = capture_delivery_log_line("abcd", 1, 2, 3, false);
  assert(borrowed.find("\"machineLeaseReleased\":false") != std::string::npos);
  assert(borrowed.find("\"machineLeaseBorrowReturned\":true") != std::string::npos);
  assert(borrowed.find("\"machineLeaseReleased\":true") == std::string::npos);
}
