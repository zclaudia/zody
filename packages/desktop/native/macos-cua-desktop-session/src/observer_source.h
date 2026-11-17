#pragma once
#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#include <memory>
#include <chrono>
#include <string>
#include "session_binding.h"
namespace zody::cua::desktop_session {
std::string observer_conflict_format(bool at_root, const std::string& role, const std::string& direct, const std::string& ax_window, bool same_reference);
void observer_conflict_diagnostic(bool at_root, const std::string& role, const std::string& direct, const std::string& ax_window, bool same_reference);
const char* observer_direct_window_mismatch_phase(uint32_t window_id);
std::string observer_diagnostic_format(const std::string& phase, const std::string& error, AXError status);
void observer_diagnostic(const std::string& phase, const std::string& error, AXError status = kAXErrorSuccess);
// 这些纯边界函数与实际 AX adapter 共用，不持有观察或授权状态。
enum class ObserverAttributeDisposition { Present, Absent, Failure };
NSString* observer_clip_text(NSString* input, bool& truncated);
bool observer_traversal_admit(size_t count, size_t depth, bool& truncated);
ObserverAttributeDisposition observer_attribute_disposition(AXError status, bool required);
bool observer_same_process(NSDate* expected, NSDate* actual);
bool observer_unique_count(size_t count);
bool observer_window_matches(pid_t expected_pid, pid_t actual_pid, bool has_window_id, uint32_t expected_id, uint32_t actual_id);
using ObserverReadDeadline = std::chrono::steady_clock::time_point;
// 生产与回归共用同一遍历；依赖只在调用栈内传入，不引入可变全局或第二状态 owner。
struct ObserverAXReader {
  AXError (*pid)(AXUIElementRef, pid_t*);
  AXError (*window)(AXUIElementRef, uint32_t*);
  AXError (*actual_pid)(AXUIElementRef, pid_t*);
  AXError (*timeout)(AXUIElementRef, float);
  AXError (*attribute)(AXUIElementRef, CFStringRef, CFTypeRef*);
  AXError (*actions)(AXUIElementRef, CFArrayRef*);
  bool (*opaque)(AXUIElementRef, pid_t, uint32_t, pid_t, uint32_t, ObserverReadDeadline);
};
bool observer_walk_tree(AXUIElementRef root, pid_t pid, uint32_t wid, ObserverReadDeadline deadline,
                        NSMutableArray* elements, NSMutableArray* handles, bool& truncated,
                        std::string& error, const ObserverAXReader& reader);
struct ObserverWindow {
  SessionTarget target;
  NSDictionary* app = nil;
  NSDate* process_started = nil;
  std::shared_ptr<void> window;
};
// 返回 nil 时 error 为固定 broker 错误码；metadata 不访问 AX children/value。
NSArray* observer_list_apps(std::string& error);
NSArray* observer_list_windows(id app_ref, std::string& error);
bool observer_resolve_window(id app_ref, ObserverWindow& result, std::string& error);
// 最终准入前的非 AX 资格检查，不读取正文、不重新解析 AX 树。
bool observer_dispatch_eligible(const ObserverWindow& window, std::string& error);
// 必须仅在本次正文授权后调用；handles 与 elements 索引一一对应。
bool observer_read_tree(const ObserverWindow& window, NSMutableArray* elements,
                        NSMutableArray* handles, bool& truncated, std::string& error);
// 资格判定单独暴露给纯测试；未知事实统一拒绝。
bool observer_eligible(bool on_console, bool login_done, bool locked_known, bool locked,
                       bool hidden_known, bool hidden, bool onscreen,
                       bool minimized_known, bool minimized);
}
