#include "control_watcher.h"
#include <atomic>
#include <cassert>
#include <chrono>
#include <thread>
using namespace zody::cua::desktop_session;
int main() {
 std::atomic<int> polls{0}, closes{0}, invalidations{0};
 std::atomic<bool> live{true};
 {
   ControlWatcher watcher([&]{return live.load();}, [&]{++polls; std::this_thread::yield(); return false;},
     [&]{++closes;}, [&]{++invalidations;});
   while (!polls.load()) std::this_thread::yield();
   live=false;
 }
 assert(closes==1 && invalidations==0);
 live=true; polls=0; closes=0; invalidations=0;
 {
   ControlWatcher watcher([&]{return live.load();}, [&]{++polls; return true;},
     [&]{++closes;}, [&]{++invalidations;});
   while (!invalidations.load()) std::this_thread::yield();
 }
 assert(invalidations==1 && closes==0);
}
