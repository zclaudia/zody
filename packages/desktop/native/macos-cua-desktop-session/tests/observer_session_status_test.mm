#include "observer_session_status.h"
#include <cassert>
#include <initializer_list>
using namespace zody::cua::desktop_session;
int main() {
  using B = SessionBoolean; using R = SessionStatus;
  SessionFacts f{B::True, B::True, B::False, B::Missing, true, true, true, false};
  assert(evaluate_session_facts(f)==R::Allowed);
  f.cg_locked=B::False; assert(evaluate_session_facts(f)==R::Allowed);
  f.cg_locked=B::True; assert(evaluate_session_facts(f)==R::Unknown);
  f.cg_locked=B::Invalid; assert(evaluate_session_facts(f)==R::Unknown);
  f.cg_locked=B::Missing; f.root_locked=B::True; assert(evaluate_session_facts(f)==R::Locked);
  f.cg_locked=B::True; assert(evaluate_session_facts(f)==R::Locked);
  f.cg_locked=B::False; assert(evaluate_session_facts(f)==R::Unknown);
  f.cg_locked=B::Invalid; assert(evaluate_session_facts(f)==R::Unknown);
  f.cg_locked=B::Missing;
  for (auto b : {B::Missing, B::Invalid}) { f.root_locked=b; assert(evaluate_session_facts(f)==R::Unknown); }
  f.root_locked=B::False;
  for (auto b : {B::Missing, B::Invalid, B::False}) { f.console=b; assert(evaluate_session_facts(f)==R::Unknown); }
  f.console=B::True;
  for (auto b : {B::Missing, B::Invalid, B::False}) { f.login=b; assert(evaluate_session_facts(f)==R::Unknown); }
  f.login=B::True;
  f.display_exists=false; assert(evaluate_session_facts(f)==R::Unknown); f.display_exists=true;
  f.display_online=false; assert(evaluate_session_facts(f)==R::Unknown); f.display_online=true;
  f.display_active=false; assert(evaluate_session_facts(f)==R::Unknown); f.display_active=true;
  f.display_asleep=true; assert(evaluate_session_facts(f)==R::Unknown);
}
