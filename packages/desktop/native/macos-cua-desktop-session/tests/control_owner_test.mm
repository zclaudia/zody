#include "control_owner.h"
#include <cassert>
#import <CoreFoundation/CoreFoundation.h>
#include <chrono>
using namespace zody::cua::desktop_session;
int main() {
  using Clock = std::chrono::steady_clock;
  const auto now = Clock::time_point{};
  int acquisitions = 0, releases = 0;
  ControlOwner owner([&] { ++acquisitions; return true; }, [&] { ++releases; });
  auto generation = owner.grant("scope", "window", now);
  assert(generation && acquisitions == 1);
  assert(owner.grant("scope", "window", now) == generation);
  assert(!owner.grant("other", "window", now));
  assert(!owner.admit("scope", "other", generation, now));
  assert(owner.admit("scope", "window", generation, now));
  owner.stop();
  assert(releases == 0);
  assert(!owner.grant("other", "window", now));
  assert(!owner.complete(generation, true, now));
  assert(releases == 1);
  generation = owner.grant("scope", "window", now);
  assert(generation && acquisitions == 2);
  owner.invalidate(generation - 1);
  assert(owner.admit("scope", "window", generation, now));
  assert(owner.complete(generation, true, now));
  assert(!owner.admit("scope", "window", generation, now + std::chrono::seconds(120)));
  assert(releases == 2);
  auto first = std::shared_ptr<void>((void*)CFSTR("window-one"), [](void*) {});
  auto replacement = std::shared_ptr<void>((void*)CFSTR("window-two"), [](void*) {});
  bool fresh = false;
  generation = owner.grant("scope", "window", now, &fresh, first);
  assert(generation && fresh);
  assert(!owner.grant("scope", "window", now, &fresh, replacement));
  assert(!fresh);
  uint64_t borrowed = 0;
  assert(!owner.begin_borrow("other", now, borrowed));
  assert(owner.begin_borrow("scope", now, borrowed) && borrowed == generation);
  owner.stop_scope("scope");
  assert(acquisitions == releases + 1);
  owner.finish_borrow(borrowed, true, now);
  assert(acquisitions == releases);
  generation = owner.grant("scope", "window", now, &fresh, first);
  assert(generation);
  owner.stop_scope("other");
  assert(owner.valid("scope", "window", generation, now));
  owner.stop_scope("scope");
  assert(!owner.valid("scope", "window", generation, now));
  generation = owner.grant("scope", "window", now, &fresh, first);
  assert(generation);
  assert(owner.begin_borrow("scope", now + std::chrono::seconds(119), borrowed));
  owner.finish_borrow(borrowed, true, now + std::chrono::seconds(119));
  assert(!owner.live(generation, now + std::chrono::seconds(120)));
  assert(acquisitions == releases);
  owner.shutdown();
  assert(!owner.grant("scope", "window", now));
}
