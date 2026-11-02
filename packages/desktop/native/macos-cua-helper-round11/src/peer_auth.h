#pragma once

#include <sys/types.h>

#include <string>

namespace zody::cua::round11 {

struct PeerExpectation {
  int pid = 0;
  uid_t uid = 0;
  std::string bundle_id;
  std::string leaf_certificate_sha256;
  std::string designated_requirement;
  bool require_empty_entitlements = true;
};

struct PeerAuthResult {
  bool ok = false;
  std::string reason;
  int peer_pid = 0;
  uid_t peer_uid = 0;
  bool token_captured = false;
  bool guest_created = false;
  bool code_valid = false;
  bool adhoc = false;
  bool certificate_present = false;
  bool hardened_runtime = false;
  bool leaf_matched = false;
  bool requirement_matched = false;
  bool identifier_matched = false;
  bool entitlements_empty = true;
  std::string identifier;
  std::string leaf_sha256;
  std::string designated_requirement;
  uint32_t flags = 0;
};

// 用 LOCAL_PEERTOKEN + Security.framework 对已连接 peer 做动态身份核验；
// 不接受 PID 猜测、argv/env 自报身份或线上 peer 自选证书 pin。
PeerAuthResult authenticate_peer_fd(int fd, const PeerExpectation& expectation);

// 双向握手：双方都先核验 peer token/证书/DR，再交换固定 HELLO 帧。
bool supervisor_handshake(int fd, const PeerExpectation& expectation, PeerAuthResult& result,
                          std::string& error);
bool helper_handshake(int fd, const PeerExpectation& expectation, PeerAuthResult& result,
                      std::string& error);

}  // namespace zody::cua::round11
