#pragma once
#import <Foundation/Foundation.h>
#include <cstdint>
#include <deque>
namespace zody::cua::desktop_session {
constexpr NSUInteger kObserverMaxResultBytes = 12 * 1024;
constexpr NSUInteger kObserverMaxMetadataResultBytes = 64 * 1024;
constexpr size_t kObserverMaxWindows = 32;
struct ObserverPreparedState {
  NSString* scope = nil;
  NSString* key = nil;
  id identity = nil;
  NSArray* elements = nil;
  NSArray* handles = nil;
  NSDictionary* result = nil;
  uint64_t sequence = 0;
  bool shown = false;
};
// 唯一状态 owner；只有 supervisor 线程读写，Stop 只关闭准入，不异步改索引。
class ObserverState {
 public:
  ObserverPreparedState prepare(NSString* scope, NSDictionary* app, NSDictionary* window,
                                id identity, NSArray* elements, NSArray* handles,
                                bool truncated, bool shown, bool disable_diffing);
  void commit(const ObserverPreparedState& pending);
  id frozen_handle(NSString* scope, NSDictionary* window, id identity, NSString* state_id,
                   NSUInteger index) const;
  bool can_promote(NSString* scope, NSDictionary* window, id identity, NSString* state_id) const;
  bool promote(NSString* scope, NSDictionary* window, id identity, NSString* state_id);
  void clear();
  size_t size() const { return entries_.size(); }
 private:
  struct Entry {
    NSString* key = nil;
    id identity = nil;
    NSArray* latest_elements = nil;
    NSArray* latest_handles = nil;
    NSArray* visible_elements = nil;
    NSArray* visible_handles = nil;
    NSString* visible_id = nil;
    uint64_t sequence = 0;
    bool force_full = true;
  };
  NSString* scope_ = nil;
  uint64_t next_sequence_ = 0;
  std::deque<Entry> entries_;
};
}
