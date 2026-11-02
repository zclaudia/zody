#pragma once

namespace zody::cua::round11::stop_visual {

// 诊断事实只描述本进程实际观察到的事件，不把授权撤销、Swift payload 归还或
// 截图失败包装成 OS/Fence 事实。
enum class AuthorityStopFact {
  None = 0,
  OwnerRevoked = 1,
  AuthorityEof = 2,
  AuthorityError = 3,
};

enum class CallbackReleaseFact {
  // 尚无真实 callback 资源；仅表示没有启动 callback，不是 actual released。
  NotStarted = 0,
  // Swift 已发 payloadReleased，且本条 operation 的真实 completion 已消费。
  Released = 1,
  // 无法证明真实 callback 资源已归还；supervisor 必须继续持 lease。
  Unknown = 2,
};

// 三种 authority 停止事实都必须 fail-closed；本函数只用于断言/审计，真正
// 的唯一取消锁存仍是 capture owner 的 revoked 原子。
inline bool reject_before_start(AuthorityStopFact fact) {
  return fact == AuthorityStopFact::OwnerRevoked || fact == AuthorityStopFact::AuthorityEof ||
         fact == AuthorityStopFact::AuthorityError;
}

inline bool authority_stop_observed(AuthorityStopFact fact) {
  return fact != AuthorityStopFact::None;
}

inline bool drop_late_frame(bool canceled) { return canceled; }

inline bool lease_release_allowed(CallbackReleaseFact fact) {
  return fact == CallbackReleaseFact::NotStarted || fact == CallbackReleaseFact::Released;
}

// 只有真正看到 callback 归还才可以写 actual callback released。
inline bool actual_callback_released(CallbackReleaseFact fact) {
  return fact == CallbackReleaseFact::Released;
}

inline const char* authority_stop_name(AuthorityStopFact fact) {
  switch (fact) {
    case AuthorityStopFact::OwnerRevoked:
      return "owner-revoked";
    case AuthorityStopFact::AuthorityEof:
      return "authority-eof";
    case AuthorityStopFact::AuthorityError:
      return "authority-error";
    case AuthorityStopFact::None:
      return "none";
  }
  return "none";
}

inline const char* callback_release_name(CallbackReleaseFact fact) {
  switch (fact) {
    case CallbackReleaseFact::NotStarted:
      return "not-started";
    case CallbackReleaseFact::Released:
      return "released";
    case CallbackReleaseFact::Unknown:
      return "unknown";
  }
  return "unknown";
}

}  // namespace zody::cua::round11::stop_visual
