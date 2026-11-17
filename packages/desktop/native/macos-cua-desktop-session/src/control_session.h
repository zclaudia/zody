#pragma once
#include "observer_session.h"
#include "control_owner.h"
#include "control_ax.h"
namespace zody::cua::desktop_session {
using ControlDispatchGuard = std::function<void(uint64_t, const std::function<void()>&)>;
struct ControlSessionOutcome { bool delivered = false; uint64_t watch_generation = 0; };
// scope is the already-validated association from ObserverSession.
ControlSessionOutcome control_session_run(NSDictionary* request, NSDictionary* scope,
    ObserverState& state, ControlOwner& owner, const ObserverSource& source,
    const ObserverExchange& exchange, const ObserverCancelled& cancelled,
    ConfirmationController& confirmation, std::string& error,
    const ControlAX& ax = control_ax_system(),
    std::function<ControlOwner::Time()> now = [] { return std::chrono::steady_clock::now(); },
    ControlDispatchGuard guard = [](uint64_t, const std::function<void()>& fn) { fn(); });
}
