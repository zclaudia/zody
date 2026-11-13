#pragma once
namespace zody::cua::desktop_session {
enum class SessionBoolean { Missing, Invalid, False, True };
enum class SessionStatus { Allowed, Locked, Unknown };
struct SessionFacts {
  SessionBoolean console, login, root_locked, cg_locked;
  bool display_exists, display_online, display_active, display_asleep;
};
SessionStatus evaluate_session_facts(const SessionFacts& facts);
SessionStatus observe_session_status();
}
