#import <Foundation/Foundation.h>
#include "observer_state.h"
#include <cassert>
using namespace zody::cua::desktop_session;
int main() {
  @autoreleasepool {
    ObserverState state;
    NSObject* window = [NSObject new];
    NSArray* elements = @[@{@"index": @0, @"kind": @"AXButton", @"title": @"A", @"value": [NSNull null], @"actions": @[@"AXPress"]}];
    NSArray* handles = @[[NSObject new]];
    auto first = state.prepare(@"lineage-1", @{@"pid": @1}, @{@"pid": @1, @"window_id": @2}, window, elements, handles, false, true, false);
    assert([first.result[@"structuredContent"][@"snapshot_mode"] isEqual:@"full"]);
    // 未交付的状态不能成为增量基线。
    auto unaccepted = state.prepare(@"lineage-1", @{@"pid": @1}, @{@"pid": @1, @"window_id": @2}, window, elements, handles, false, true, false);
    assert([unaccepted.result[@"structuredContent"][@"snapshot_mode"] isEqual:@"full"]);
    state.commit(first);
    auto second = state.prepare(@"lineage-1", @{@"pid": @1}, @{@"pid": @1, @"window_id": @2}, window, elements, handles, false, true, false);
    assert([second.result[@"structuredContent"][@"snapshot_mode"] isEqual:@"diff"]);
    assert([second.result[@"structuredContent"][@"base_state_id"] isEqual:first.result[@"structuredContent"][@"state_id"]]);
    auto moved = state.prepare(@"lineage-1", @{@"pid": @1}, @{@"pid": @1, @"window_id": @2}, window, elements, @[[NSObject new]], false, true, false);
    assert([moved.result[@"structuredContent"][@"snapshot_mode"] isEqual:@"full"]);
    auto silent = state.prepare(@"lineage-1", @{@"pid": @1}, @{@"pid": @1, @"window_id": @2}, window, elements, handles, false, false, false);
    state.commit(silent);
    auto after_silent = state.prepare(@"lineage-1", @{@"pid": @1}, @{@"pid": @1, @"window_id": @2}, window, elements, handles, false, true, false);
    assert([after_silent.result[@"structuredContent"][@"snapshot_mode"] isEqual:@"full"]);
    auto rebuilt = state.prepare(@"lineage-1", @{@"pid": @1}, @{@"pid": @1, @"window_id": @2}, [NSObject new], elements, handles, false, true, false);
    assert([rebuilt.result[@"structuredContent"][@"snapshot_mode"] isEqual:@"full"]);
    auto other = state.prepare(@"lineage-2", @{@"pid": @1}, @{@"pid": @1, @"window_id": @2}, window, elements, handles, false, true, false);
    assert([other.result[@"structuredContent"][@"snapshot_mode"] isEqual:@"full"]);
    state.commit(other);
    for (int i = 0; i < 40; ++i) {
      auto entry = state.prepare(@"lineage-2", @{@"pid": @1}, @{@"pid": @1, @"window_id": @(i + 10)}, window, elements, handles, false, true, false);
      state.commit(entry);
    }
    assert(state.size() == 32);
    NSArray* huge = @[@{@"index": @0, @"kind": [@"x" stringByPaddingToLength:13000 withString:@"x" startingAtIndex:0]}];
    auto oversized = state.prepare(@"lineage-2", @{@"pid": @1}, @{@"pid": @1, @"window_id": @90}, window, huge, handles, false, true, false);
    assert(oversized.result == nil);
    puts("observer-state: passed");
  }
}
