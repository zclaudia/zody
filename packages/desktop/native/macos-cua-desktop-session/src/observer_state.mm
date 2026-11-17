#include "observer_state.h"
namespace zody::cua::desktop_session {
namespace {
NSString* element_line(NSDictionary* element) {
  NSData* data = [NSJSONSerialization dataWithJSONObject:element options:NSJSONWritingSortedKeys error:nil];
  return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"";
}
NSString* full_text(NSArray* elements, bool truncated) {
  NSMutableString* text = [NSMutableString stringWithString:@"AX window state (indices address this observation)\n"];
  for (NSDictionary* element in elements) [text appendFormat:@"%@\n", element_line(element)];
  if (truncated) [text appendString:@"[truncated: only returned indices are available]\n"];
  return text;
}
NSString* diff_text(NSArray* before, NSArray* after, bool truncated) {
  NSMutableString* text = [NSMutableString stringWithString:@"AX window diff\n"];
  NSMutableDictionary* old = [NSMutableDictionary dictionary];
  NSMutableDictionary* current = [NSMutableDictionary dictionary];
  for (NSDictionary* element in before) old[element[@"index"]] = element;
  for (NSDictionary* element in after) current[element[@"index"]] = element;
  for (NSDictionary* element in before) {
    if (!current[element[@"index"]]) [text appendFormat:@"removed %@\n", element[@"index"]];
  }
  for (NSDictionary* element in after) {
    NSDictionary* prior = old[element[@"index"]];
    if (!prior) [text appendFormat:@"added %@\n", element_line(element)];
    else if (![prior isEqual:element]) [text appendFormat:@"changed %@\n", element_line(element)];
  }
  if (truncated) [text appendString:@"[truncated: only returned indices are available]\n"];
  return text;
}
}
ObserverPreparedState ObserverState::prepare(NSString* scope, NSDictionary* app, NSDictionary* window,
                                            id identity, NSArray* elements, NSArray* handles,
                                            bool truncated, bool shown, bool disable_diffing) {
  ObserverPreparedState pending;
  if (!scope || !identity || !app || !window || !elements || !handles || elements.count != handles.count) return pending;
  // 原因：lineage/revision 改变后不能继承旧授权窗口的元素或模型基线。
  if (![scope_ isEqual:scope]) { clear(); scope_ = [scope copy]; }
  pending.scope = [scope copy];
  pending.key = [NSString stringWithFormat:@"%@:%@", window[@"pid"], window[@"window_id"]];
  pending.identity = identity;
  pending.elements = [[NSArray alloc] initWithArray:elements copyItems:YES];
  pending.handles = [handles copy];
  pending.sequence = ++next_sequence_;
  pending.shown = shown;
  Entry* baseline = nullptr;
  for (auto entry = entries_.begin(); entry != entries_.end(); ++entry) {
    if (![entry->key isEqual:pending.key]) continue;
    if (![entry->identity isEqual:identity]) entries_.erase(entry);
    else baseline = &*entry;
    break;
  }
  // 原因：同文案控件交换后字典可能完全相同，native 引用位移仍必须展示整树，
  // 不能把新索引映射静默伪装为无变化的 diff。
  const bool diff = shown && !disable_diffing && baseline && !baseline->force_full &&
    baseline->visible_id && [baseline->visible_handles isEqual:pending.handles];
  NSString* state_id = [NSString stringWithFormat:@"%llu", static_cast<unsigned long long>(pending.sequence)];
  NSString* text = diff ? diff_text(baseline->visible_elements, pending.elements, truncated)
                        : full_text(pending.elements, truncated);
  NSMutableDictionary* structured = [@{ @"state_id": state_id, @"app": app, @"window": window,
      @"elements": pending.elements, @"text": text, @"snapshot_mode": diff ? @"diff" : @"full",
      @"truncated": @(truncated) } mutableCopy];
  if (diff) structured[@"base_state_id"] = baseline->visible_id;
  NSDictionary* result = @{ @"content": @[@{ @"type": @"text", @"text": text }], @"structuredContent": structured };
  NSData* data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
  if (data && data.length <= kObserverMaxResultBytes) pending.result = result;
  return pending;
}
void ObserverState::commit(const ObserverPreparedState& pending) {
  if (!pending.result || ![pending.scope isEqual:scope_]) return;
  for (auto entry = entries_.begin(); entry != entries_.end(); ++entry) {
    if (![entry->key isEqual:pending.key]) continue;
    if (entry->sequence >= pending.sequence) return;
    Entry update = *entry;
    entries_.erase(entry);
    if (![update.identity isEqual:pending.identity]) update = Entry();
    update.key = pending.key;
    update.identity = pending.identity;
    update.latest_elements = pending.elements;
    update.latest_handles = pending.handles;
    update.sequence = pending.sequence;
    update.force_full = !pending.shown;
    if (pending.shown) {
      update.visible_elements = pending.elements;
      update.visible_handles = pending.handles;
      update.visible_id = pending.result[@"structuredContent"][@"state_id"];
    }
    entries_.push_back(std::move(update));
    return;
  }
  if (entries_.size() >= kObserverMaxWindows) entries_.pop_front();
  Entry update;
  update.key = pending.key;
  update.identity = pending.identity;
  update.latest_elements = pending.elements;
  update.latest_handles = pending.handles;
  update.sequence = pending.sequence;
  update.force_full = !pending.shown;
  if (pending.shown) {
    update.visible_elements = pending.elements;
    update.visible_handles = pending.handles;
    update.visible_id = pending.result[@"structuredContent"][@"state_id"];
  }
  entries_.push_back(std::move(update));
}
id ObserverState::frozen_handle(NSString* scope, NSDictionary* window, id identity,
                                NSString* state_id, NSUInteger index) const {
  if (!scope || !window || !identity || !state_id || ![scope_ isEqual:scope]) return nil;
  NSString* key = [NSString stringWithFormat:@"%@:%@", window[@"pid"], window[@"window_id"]];
  for (const auto& entry : entries_) {
    // 静默或新映射未交付时旧索引不再可靠，必须等待新的模型可见整树。
    if (![entry.key isEqual:key] || ![entry.identity isEqual:identity] || entry.force_full ||
        ![entry.visible_id isEqual:state_id] || index >= entry.visible_handles.count ||
        index >= entry.visible_elements.count) continue;
    if (![entry.visible_elements[index][@"index"] isEqual:@(index)]) return nil;
    return entry.visible_handles[index];
  }
  return nil;
}
bool ObserverState::can_promote(NSString* scope, NSDictionary* window, id identity, NSString* state_id) const {
  if (!scope || !window || !identity || !state_id || ![scope_ isEqual:scope]) return false;
  NSString* key = [NSString stringWithFormat:@"%@:%@", window[@"pid"], window[@"window_id"]];
  for (const auto& entry : entries_) {
    NSString* latest = [NSString stringWithFormat:@"%llu", static_cast<unsigned long long>(entry.sequence)];
    if ([entry.key isEqual:key] && [entry.identity isEqual:identity] && entry.force_full &&
        [latest isEqual:state_id] && entry.latest_elements && entry.latest_handles &&
        entry.latest_elements.count == entry.latest_handles.count) return true;
  }
  return false;
}
bool ObserverState::promote(NSString* scope, NSDictionary* window, id identity, NSString* state_id) {
  if (!can_promote(scope, window, identity, state_id)) return false;
  NSString* key = [NSString stringWithFormat:@"%@:%@", window[@"pid"], window[@"window_id"]];
  for (auto& entry : entries_) {
    if (![entry.key isEqual:key]) continue;
    // 像素与正文实际交付、ACK 后才能提升原冻结索引，不重新遍历或更换句柄。
    entry.visible_elements=entry.latest_elements;
    entry.visible_handles=entry.latest_handles;
    entry.visible_id=[state_id copy];
    entry.force_full=false;
    return true;
  }
  return false;
}
void ObserverState::clear() { entries_.clear(); scope_ = nil; }
}
