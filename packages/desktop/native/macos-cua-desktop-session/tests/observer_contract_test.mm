#import <Foundation/Foundation.h>
#include "observer_contract.h"
#include <cassert>
using namespace zody::cua::desktop_session;
int main() {
  @autoreleasepool {
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
