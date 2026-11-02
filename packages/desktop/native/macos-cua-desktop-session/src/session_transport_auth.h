#pragma once

#include <atomic>
#include <cstddef>
#include <string>

namespace zody::cua::desktop_session {

// Helper 与 sealed CLI 共用的一次性 transport 认证。key 只经 inherited fd3
// session-ready 交付，不进入 env/argv/日志/模型/evidence。
enum class TransportRole { Cell, Authority };

constexpr size_t kTransportAuthenticationKeyBytes = 32;
constexpr size_t kTransportChallengeBytes = 32;
constexpr size_t kTransportProofMaxFrameBytes = 16 * 1024;
constexpr size_t kTransportProofMaxBoundBytes = 64 * 1024 * 1024;

struct TransportProofRequest {
  TransportRole role = TransportRole::Authority;
  std::string challenge_hex;
  std::string source_sha256;
  size_t request_max_bytes = 0;
  size_t response_max_bytes = 0;
};

bool generate_transport_authentication_key(std::string& key_hex);
bool is_valid_transport_authentication_key(const std::string& key_hex);
bool is_valid_transport_challenge(const std::string& challenge_hex);

// 固定顺序：
// zody.cua.desktop-session.transport.helper-proof|<version>|<role>|<challengeHex>|
// <sourceShaHexOrEmpty>|<decimalRequestMax>|<decimalResponseMax>
bool transport_proof_canonical(TransportRole role, const std::string& challenge_hex,
                               const std::string& source_sha256_hex,
                               size_t request_max_bytes, size_t response_max_bytes,
                               std::string& canonical, std::string& error);

bool compute_transport_proof(const std::string& key_hex, const std::string& canonical,
                             std::string& proof_hex, std::string& error);
bool verify_transport_proof(const std::string& key_hex, const std::string& canonical,
                            const std::string& proof_hex);

// 私有 fd 上的固定认证帧；authority 与 cell 都只接受严格 shape，不接受额外字段。
bool parse_transport_proof_request_line(const std::string& line, size_t max_bytes,
                                        TransportProofRequest& request, std::string& error);
std::string serialize_transport_proof_request(TransportRole role,
                                              const std::string& challenge_hex,
                                              const std::string& source_sha256,
                                              size_t request_max_bytes,
                                              size_t response_max_bytes);
std::string serialize_transport_proof(TransportRole role, const std::string& challenge_hex,
                                      const std::string& proof_hex);
std::string serialize_transport_error(const std::string& reason);

// authority 连接在进入原 bootstrap/AuthorityFdReader 之前完成一次 proof 往返。
// 读取请求时多读到的字节（同包 bootstrap）原样放入 remainder，不能丢弃。
bool perform_authority_transport_auth(int fd, const std::string& key_hex, int timeout_ms,
                                      const std::atomic<bool>& stop, std::string& remainder,
                                      std::string& error);

}  // namespace zody::cua::desktop_session
