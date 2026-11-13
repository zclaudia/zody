#import <Foundation/Foundation.h>
#include "observer_source.h"
#include <cassert>
#include <unistd.h>
#include <string>
using namespace zody::cua::desktop_session;
int main() {
  assert(observer_eligible(true,true,true,false,true,false,true,true,false));
  assert(!observer_eligible(false,true,true,false,true,false,true,true,false));
  assert(!observer_eligible(true,true,true,true,true,false,true,true,false));
  assert(!observer_eligible(true,true,false,false,true,false,true,true,false));
  assert(!observer_eligible(true,true,true,false,false,false,true,true,false));
  assert(!observer_eligible(true,true,true,false,true,true,true,true,false));
  assert(!observer_eligible(true,true,true,false,true,false,false,true,false));
  assert(!observer_eligible(true,true,true,false,true,false,true,false,false));
  assert(!observer_eligible(true,true,true,false,true,false,true,true,true));
  @autoreleasepool {
    assert(observer_diagnostic_format("ax_windows_status", "element_unavailable", kAXErrorCannotComplete) == "[cua-native] observation-rejected {\"phase\":\"ax_windows_status\",\"code\":\"element_unavailable\",\"ax\":\"cannot_complete\"}");
    assert(observer_diagnostic_format("secret-title", "secret-path", static_cast<AXError>(123456)) == "[cua-native] observation-rejected {\"phase\":\"unknown\",\"code\":\"unknown\",\"ax\":\"unknown\"}");
    int capture[2]; assert(pipe(capture) == 0); int saved = dup(STDERR_FILENO); assert(saved >= 0);
    assert(dup2(capture[1], STDERR_FILENO) >= 0); close(capture[1]);
    observer_diagnostic("secret-title", "secret-path", static_cast<AXError>(123456));
    assert(dup2(saved, STDERR_FILENO) >= 0); close(saved);
    char buffer[256] = {}; ssize_t count = read(capture[0], buffer, sizeof(buffer)); close(capture[0]);
    assert(count > 0 && std::string(buffer, static_cast<size_t>(count)) == "[cua-native] observation-rejected {\"phase\":\"unknown\",\"code\":\"unknown\",\"ax\":\"unknown\"}\n");
    assert(std::string(observer_direct_window_mismatch_phase(0)) == "node_direct_window_zero");
    assert(std::string(observer_direct_window_mismatch_phase(1)) == "node_direct_window");
    assert(std::string(observer_direct_window_mismatch_phase(UINT32_MAX)) == "node_direct_window");
    assert(observer_diagnostic_format(observer_direct_window_mismatch_phase(0), "element_unavailable", kAXErrorSuccess) == "[cua-native] observation-rejected {\"phase\":\"node_direct_window_zero\",\"code\":\"element_unavailable\",\"ax\":\"success\"}");
    assert(observer_conflict_format(true, "window", "same_process", "target", true) == "[cua-native] observation-window-conflict {\"atRoot\":true,\"role\":\"window\",\"direct\":\"same_process\",\"axWindow\":\"target\",\"axWindowIsTargetReference\":true}");
    assert(observer_conflict_format(false, "secret-role", "secret-id", "secret-value", false) == "[cua-native] observation-window-conflict {\"atRoot\":false,\"role\":\"unknown\",\"direct\":\"unknown\",\"axWindow\":\"unknown\",\"axWindowIsTargetReference\":false}");
    int conflict_pipe[2]; assert(pipe(conflict_pipe) == 0); saved = dup(STDERR_FILENO); assert(saved >= 0);
    assert(dup2(conflict_pipe[1], STDERR_FILENO) >= 0); close(conflict_pipe[1]);
    observer_conflict_diagnostic(false, "secret-role", "secret-id", "secret-value", false);
    assert(dup2(saved, STDERR_FILENO) >= 0); close(saved);
    char conflict_buffer[256] = {}; count = read(conflict_pipe[0], conflict_buffer, sizeof(conflict_buffer)); close(conflict_pipe[0]);
    assert(count > 0 && std::string(conflict_buffer, static_cast<size_t>(count)) == observer_conflict_format(false, "unknown", "unknown", "unknown", false) + "\n");
    bool truncated=false;
    NSString* long_text=[@"a" stringByPaddingToLength:255 withString:@"a" startingAtIndex:0];
    NSString* clipped=observer_clip_text([long_text stringByAppendingString:@"中"], truncated);
    assert(truncated && [clipped lengthOfBytesUsingEncoding:NSUTF8StringEncoding]==255);
    truncated=false;
    NSString* exact=[@"a" stringByPaddingToLength:256 withString:@"a" startingAtIndex:0];
    assert([observer_clip_text(exact,truncated) isEqualToString:exact] && !truncated);
    truncated=false;
    NSString* emoji=[[@"a" stringByPaddingToLength:254 withString:@"a" startingAtIndex:0] stringByAppendingString:@"😀"];
    assert([observer_clip_text(emoji,truncated) lengthOfBytesUsingEncoding:NSUTF8StringEncoding]==254 && truncated);
    truncated=false;
    assert(observer_traversal_admit(63,15,truncated) && !truncated);
    assert(!observer_traversal_admit(64,15,truncated) && truncated);
    truncated=false;
    assert(!observer_traversal_admit(0,16,truncated) && truncated);
    assert(observer_attribute_disposition(kAXErrorNoValue, false)==ObserverAttributeDisposition::Absent);
    assert(observer_attribute_disposition(kAXErrorNoValue, true)==ObserverAttributeDisposition::Failure);
    assert(observer_attribute_disposition(kAXErrorCannotComplete, false)==ObserverAttributeDisposition::Failure);
    assert(observer_attribute_disposition(kAXErrorSuccess, true)==ObserverAttributeDisposition::Present);
    assert(observer_attribute_disposition(kAXErrorAttributeUnsupported, false)==ObserverAttributeDisposition::Absent);
    NSDate* date=[NSDate dateWithTimeIntervalSince1970:1];
    assert(observer_same_process(date,date));
    assert(!observer_same_process(date,[NSDate dateWithTimeIntervalSince1970:2]));
    assert(!observer_same_process(nil,date));
    assert(observer_window_matches(100,100,true,7,7));
    assert(!observer_window_matches(100,101,true,7,7));
    assert(!observer_window_matches(100,100,true,7,8));
    assert(observer_window_matches(100,100,false,7,0));
    assert(observer_unique_count(1));
    assert(!observer_unique_count(0) && !observer_unique_count(2));
    std::string error; NSArray* apps = observer_list_apps(error); assert(apps || !error.empty());
    AXUIElementRef element = AXUIElementCreateApplication(getpid());
    assert(element); NSMutableArray* handles = [NSMutableArray array];
    [handles addObject:(__bridge id)element]; CFRelease(element);
    assert(CFGetTypeID((__bridge CFTypeRef)handles[0]) == AXUIElementGetTypeID());
  }
  return 0;
}
