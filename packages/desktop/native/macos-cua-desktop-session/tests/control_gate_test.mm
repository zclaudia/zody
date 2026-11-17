#include "control_gate.h"
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>
using namespace zody::cua::desktop_session;
int main() {
  using Clock = std::chrono::steady_clock;
  const auto start = Clock::time_point{};
  ControlGate gate;
  auto generation = gate.grant(start);
  assert(generation != 0);
  assert(gate.grant(start) == 0);
  assert(gate.admit(generation, start + std::chrono::seconds(119)));
  gate.stop();
  assert(gate.grant(start) == 0);
  assert(!gate.complete(generation, true, start + std::chrono::seconds(119)));
  assert(!gate.admit(generation, start + std::chrono::seconds(119)));
  assert(gate.in_flight() == 0);
  generation = gate.grant(start);
  assert(!gate.admit(generation, start + std::chrono::seconds(120)));
  generation = gate.grant(start);
  assert(gate.admit(generation, start + std::chrono::seconds(119)));
  assert(gate.complete(generation, true, start + std::chrono::seconds(119)));
  assert(gate.admit(generation, start + std::chrono::seconds(238)));
  assert(!gate.complete(generation, false, start + std::chrono::seconds(238)));
  assert(!gate.admit(generation, start + std::chrono::seconds(239)));
  generation = gate.grant(start);
  std::mutex mutex;
  std::condition_variable condition;
  bool admitted = false;
  bool release = false;
  bool renewed = true;
  std::thread worker([&] {
    assert(gate.admit(generation, start));
    {
      std::unique_lock<std::mutex> lock(mutex);
      admitted = true;
      condition.notify_one();
      condition.wait(lock, [&] { return release; });
    }
    renewed = gate.complete(generation, true, start + std::chrono::seconds(1));
  });
  {
    std::unique_lock<std::mutex> lock(mutex);
    condition.wait(lock, [&] { return admitted; });
  }
  gate.stop(); // Must return while the simulated AX operation remains blocked.
  assert(gate.in_flight() == 1);
  assert(gate.grant(start) == 0);
  {
    std::lock_guard<std::mutex> lock(mutex);
    release = true;
  }
  condition.notify_one();
  worker.join();
  assert(!renewed);
  assert(gate.in_flight() == 0);
  generation = gate.grant(start);
  assert(generation != 0);
  auto next = gate.grant(start + std::chrono::seconds(120));
  assert(next != 0 && next != generation);
  assert(!gate.admit(generation, start + std::chrono::seconds(120)));
  assert(gate.admit(next, start + std::chrono::seconds(120)));
  gate.stop();
  assert(!gate.complete(next, true, start + std::chrono::seconds(121)));
}
