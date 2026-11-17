#import <Foundation/Foundation.h>
#include "observer_contract.h"
#include <cassert>
using namespace zody::cua::desktop_session;
int main() {
  @autoreleasepool {
    assert(control_request_valid(@{ @"method": @"left_click", @"arguments": @{
      @"app_ref": @{ @"pid": @1, @"window_id": @2 }, @"target": @{ @"type": @"element", @"index": @0 }, @"state_id": @"1" } }));
    assert(!control_request_valid(@{ @"method": @"left_click", @"arguments": @{
      @"app_ref": @{ @"pid": @1, @"window_id": @2 }, @"target": @{ @"type": @"coordinate", @"index": @0 }, @"state_id": @"1" } }));
    assert(!control_request_valid(@{ @"method": @"left_click", @"arguments": @{
      @"app_ref": @{ @"pid": @1 }, @"target": @{ @"type": @"element", @"index": @0 }, @"state_id": @"1", @"strategy": @"event" } }));
    assert(observer_request_valid(@{ @"method": @"commit_state", @"arguments": @{ @"app_ref": @{ @"pid": @1, @"window_id": @2 }, @"state_id": @"3" } }));
    assert(!observer_request_valid(@{ @"method": @"commit_state", @"arguments": @{ @"app_ref": @{ @"pid": @1 }, @"state_id": @"3", @"extra": @1 } }));
    assert(observer_request_valid(@{ @"method": @"list_apps", @"arguments": @{} }));
    assert(observer_request_valid(@{ @"method": @"get_app_state", @"arguments": @{ @"app_ref": @{ @"pid": @1, @"window_id": @2 }, @"tree_shown_to_model": @NO } }));
    assert(observer_request_valid(@{ @"method": @"get_app_state", @"arguments": @{ @"app_ref": @"com.example.app" } }));
    assert(!observer_request_valid(@{ @"method": @"get_app_state", @"arguments": @{ @"app_ref": @{ @"name": @"   " } } }));
    assert(!observer_request_valid(@{ @"method": @"set_value", @"arguments": @{} }));
    assert(!observer_request_valid(@{ @"method": @"list_apps", @"arguments": @{ @"extra": @1 } }));
    assert(!observer_request_valid(@{ @"method": @"get_app_state", @"arguments": @{ @"app_ref": @{ @"pid": @YES } } }));
    assert(!observer_request_valid(@{ @"method": @"get_app_state", @"arguments": @{ @"app_ref": @{ @"pid": @1, @"unknown": @2 } } }));
    assert(!observer_request_valid(@{ @"method": @"get_app_state", @"arguments": @{ @"app_ref": @{ @"pid": @1 }, @"disable_diffing": @1 } }));
  }
  return 0;
}
