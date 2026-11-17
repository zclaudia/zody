#pragma once
#include "observer_source.h"
#include "observer_state.h"
#include "confirmation.h"
#include <functional>
namespace zody::cua::desktop_session {
class ControlOwner;
struct ObserverSource {
  std::function<NSArray*(std::string&)> apps = observer_list_apps;
  std::function<NSArray*(id, std::string&)> windows = observer_list_windows;
  std::function<bool(id, ObserverWindow&, std::string&)> resolve = observer_resolve_window;
  std::function<bool(const ObserverWindow&, std::string&)> dispatch_eligible = observer_dispatch_eligible;
  std::function<bool(const ObserverWindow&, NSMutableArray*, NSMutableArray*, bool&, std::string&)> read = observer_read_tree;
};
using ObserverExchange = std::function<NSDictionary*(NSString*, NSDictionary*, std::string&)>;
using ObserverCancelled = std::function<bool(std::string&)>;
// 持有唯一观察状态；exchange 只消费当前已认证 authority 连接，不制造身份。
class ObserverSession {
 public:
  explicit ObserverSession(ObserverSource source = {}) : source_(std::move(source)) {}
  bool run(NSDictionary* bootstrap, const std::string& expected_producer,
           const ObserverExchange& exchange, const ObserverCancelled& cancelled,
           ConfirmationController& confirmation, std::string& error,
           ControlOwner* control = nullptr, uint64_t* watch_generation = nullptr,
           std::function<void(uint64_t, const std::function<void()>&)> guard = {});
 private:
  ObserverSource source_;
  ObserverState state_;
};
}
