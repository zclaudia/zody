#include "session_transport_auth.h"

#import <CoreFoundation/CoreFoundation.h>
#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonHMAC.h>

#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>

namespace zody::cua::desktop_session {
namespace {

constexpr const char* kProofDomain = "zody.cua.desktop-session.transport.helper-proof";
constexpr const char* kProofVersion = "1";

bool is_lower_hex(const std::string& value, size_t exact_bytes) {
  if (value.size() != exact_bytes * 2) return false;
  for (char character : value) {
    if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) {
      return false;
    }
  }
  return true;
}

bool contains_forbidden_bytes(const std::string& value) {
  return value.find('\0') != std::string::npos || value.find('\n') != std::string::npos ||
         value.find('\r') != std::string::npos;
}

int hex_value(char character) {
  if (character >= '0' && character <= '9') return character - '0';
  if (character >= 'a' && character <= 'f') return character - 'a' + 10;
  return -1;
}

bool decode_hex(const std::string& value, size_t expected_bytes, unsigned char* out) {
  if (!is_lower_hex(value, expected_bytes)) return false;
  for (size_t index = 0; index < expected_bytes; ++index) {
    const int high = hex_value(value[index * 2]);
    const int low = hex_value(value[index * 2 + 1]);
    if (high < 0 || low < 0) return false;
    out[index] = static_cast<unsigned char>((high << 4) | low);
  }
  return true;
}

std::string encode_hex(const unsigned char* bytes, size_t length) {
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.reserve(length * 2);
  for (size_t index = 0; index < length; ++index) {
    out.push_back(hex[(bytes[index] >> 4) & 0x0f]);
    out.push_back(hex[bytes[index] & 0x0f]);
  }
  return out;
}

bool constant_time_equal(const unsigned char* left, const unsigned char* right, size_t length) {
  unsigned char difference = 0;
  for (size_t index = 0; index < length; ++index) {
    difference |= static_cast<unsigned char>(left[index] ^ right[index]);
  }
  return difference == 0;
}

bool exact_keys(NSDictionary* dictionary, NSArray<NSString*>* keys) {
  if (![dictionary isKindOfClass:[NSDictionary class]]) return false;
  if (dictionary.count != keys.count) return false;
  for (NSString* key in keys) {
    if (dictionary[key] == nil) return false;
  }
  return true;
}

bool is_cf_number(id value) {
  return value != nil && CFGetTypeID((__bridge CFTypeRef)value) == CFNumberGetTypeID();
}

bool is_cf_string(id value) {
  return value != nil && CFGetTypeID((__bridge CFTypeRef)value) == CFStringGetTypeID();
}

bool strict_schema_version_one(id value) {
  if (!is_cf_number(value) || ![value isKindOfClass:[NSNumber class]]) return false;
  return [static_cast<NSNumber*>(value) isEqual:@1];
}

bool strict_string_is(id value, NSString* expected) {
  if (!is_cf_string(value) || ![value isKindOfClass:[NSString class]]) return false;
  return [static_cast<NSString*>(value) isEqualToString:expected];
}

bool bounded_integer(id value, size_t max_value, bool allow_zero, size_t& out) {
  if (!is_cf_number(value) || ![value isKindOfClass:[NSNumber class]]) return false;
  const double raw = [static_cast<NSNumber*>(value) doubleValue];
  // 中文原因：先 isfinite 再比较/cast，拒绝 inf/NaN 造成的 double->size_t UB。
  if (!std::isfinite(raw) || raw < (allow_zero ? 0 : 1) ||
      raw > static_cast<double>(max_value) || std::floor(raw) != raw) {
    return false;
  }
  out = static_cast<size_t>(raw);
  return true;
}

bool string_bytes(id value, std::string& out) {
  if (!is_cf_string(value) || ![value isKindOfClass:[NSString class]]) return false;
  NSData* data = [static_cast<NSString*>(value) dataUsingEncoding:NSUTF8StringEncoding
                                              allowLossyConversion:NO];
  if (data == nil) return false;
  out.assign(static_cast<const char*>(data.bytes), data.length);
  return out.find('\0') == std::string::npos;
}

const char* role_text(TransportRole role) {
  switch (role) {
    case TransportRole::Cell:
      return "cell";
    case TransportRole::Authority:
      return "authority";
  }
  return nullptr;
}

bool parse_role(id value, TransportRole& role) {
  if (strict_string_is(value, @"cell")) {
    role = TransportRole::Cell;
    return true;
  }
  if (strict_string_is(value, @"authority")) {
    role = TransportRole::Authority;
    return true;
  }
  return false;
}

bool fixed_reason(const std::string& reason) {
  if (reason.empty() || reason.size() > 256) return false;
  for (unsigned char byte : reason) {
    if (byte < 0x20 || byte == 0x7f) return false;
  }
  return true;
}

std::string json_line(NSDictionary* frame) {
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:frame
                                                options:NSJSONWritingSortedKeys
                                                  error:&error];
  if (data == nil || error != nil) return "";
  std::string line(static_cast<const char*>(data.bytes), data.length);
  line.push_back('\n');
  return line;
}

bool wait_fd(int fd, short events, int timeout_ms, const std::atomic<bool>& stop) {
  if (stop.load(std::memory_order_acquire)) return false;
  struct pollfd entry {};
  entry.fd = fd;
  entry.events = events;
  int result = 0;
  do {
    result = poll(&entry, 1, timeout_ms);
  } while (result < 0 && errno == EINTR);
  if (result <= 0) return false;
  return (entry.revents & (events | POLLHUP | POLLERR)) != 0;
}

bool send_all(int fd, const std::string& bytes, int timeout_ms, const std::atomic<bool>& stop,
              std::string& error) {
  size_t offset = 0;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (offset < bytes.size()) {
    if (stop.load(std::memory_order_acquire)) {
      error = "authority-transport-stopping";
      return false;
    }
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                               deadline - std::chrono::steady_clock::now())
                               .count();
    if (remaining <= 0) {
      error = "authority-transport-write-timeout";
      return false;
    }
    if (!wait_fd(fd, POLLOUT, static_cast<int>(remaining), stop)) {
      error = "authority-transport-write-failed";
      return false;
    }
    const ssize_t count = send(fd, bytes.data() + offset, bytes.size() - offset, 0);
    if (count < 0) {
      if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue;
      error = "authority-transport-write-failed";
      return false;
    }
    if (count == 0) {
      error = "authority-transport-write-failed";
      return false;
    }
    offset += static_cast<size_t>(count);
  }
  return true;
}

bool read_line_preserving(int fd, size_t max_bytes, int timeout_ms,
                          const std::atomic<bool>& stop, std::string& line,
                          std::string& remainder, std::string& error) {
  line.clear();
  remainder.clear();
  std::string buffer;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (true) {
    const size_t newline = buffer.find('\n');
    if (newline != std::string::npos) {
      line = buffer.substr(0, newline);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      remainder = buffer.substr(newline + 1);
      if (line.size() > max_bytes) {
        error = "authority-transport-frame-too-large";
        return false;
      }
      return true;
    }
    if (buffer.size() > max_bytes) {
      error = "authority-transport-frame-too-large";
      return false;
    }
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                               deadline - std::chrono::steady_clock::now())
                               .count();
    if (remaining <= 0) {
      error = "authority-transport-timeout";
      return false;
    }
    if (!wait_fd(fd, POLLIN, static_cast<int>(remaining), stop)) {
      error = stop.load(std::memory_order_acquire) ? "authority-transport-stopping"
                                                   : "authority-transport-read-failed";
      return false;
    }
    char chunk[4096];
    const ssize_t count = recv(fd, chunk, sizeof(chunk), 0);
    if (count == 0) {
      error = "authority-transport-eof";
      return false;
    }
    if (count < 0) {
      if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue;
      error = "authority-transport-read-failed";
      return false;
    }
    buffer.append(chunk, static_cast<size_t>(count));
  }
}

}  // namespace

bool generate_transport_authentication_key(std::string& key_hex) {
  unsigned char bytes[kTransportAuthenticationKeyBytes];
  arc4random_buf(bytes, sizeof(bytes));
  key_hex = encode_hex(bytes, sizeof(bytes));
  // 中文原因：即使 CSPRNG 异常，也不能把全零 key 当有效 key 继续。
  std::memset(bytes, 0, sizeof(bytes));
  unsigned char decoded[kTransportAuthenticationKeyBytes];
  const bool valid = decode_hex(key_hex, kTransportAuthenticationKeyBytes, decoded);
  const bool non_zero = valid && decoded[0] != 0;
  std::memset(decoded, 0, sizeof(decoded));
  return valid && (non_zero || key_hex != std::string(64, '0'));
}

bool is_valid_transport_authentication_key(const std::string& key_hex) {
  return is_lower_hex(key_hex, kTransportAuthenticationKeyBytes);
}

bool is_valid_transport_challenge(const std::string& challenge_hex) {
  return is_lower_hex(challenge_hex, kTransportChallengeBytes);
}

bool transport_proof_canonical(TransportRole role, const std::string& challenge_hex,
                               const std::string& source_sha256_hex,
                               size_t request_max_bytes, size_t response_max_bytes,
                               std::string& canonical, std::string& error) {
  canonical.clear();
  error.clear();
  if (!is_valid_transport_challenge(challenge_hex) || contains_forbidden_bytes(challenge_hex)) {
    error = "transport-proof-challenge-invalid";
    return false;
  }
  if (contains_forbidden_bytes(source_sha256_hex)) {
    error = "transport-proof-source-invalid";
    return false;
  }
  const char* role_text = nullptr;
  if (role == TransportRole::Cell) {
    if (!is_lower_hex(source_sha256_hex, 32) || request_max_bytes == 0 ||
        response_max_bytes == 0) {
      error = "transport-proof-cell-fields-invalid";
      return false;
    }
    role_text = "cell";
  } else if (role == TransportRole::Authority) {
    if (!source_sha256_hex.empty() || request_max_bytes != 0 || response_max_bytes != 0) {
      error = "transport-proof-authority-fields-invalid";
      return false;
    }
    role_text = "authority";
  } else {
    error = "transport-proof-role-invalid";
    return false;
  }
  canonical.reserve(256);
  canonical.append(kProofDomain);
  canonical.push_back('|');
  canonical.append(kProofVersion);
  canonical.push_back('|');
  canonical.append(role_text);
  canonical.push_back('|');
  canonical.append(challenge_hex);
  canonical.push_back('|');
  canonical.append(source_sha256_hex);
  canonical.push_back('|');
  canonical.append(std::to_string(request_max_bytes));
  canonical.push_back('|');
  canonical.append(std::to_string(response_max_bytes));
  return true;
}

bool compute_transport_proof(const std::string& key_hex, const std::string& canonical,
                             std::string& proof_hex, std::string& error) {
  proof_hex.clear();
  error.clear();
  unsigned char key[kTransportAuthenticationKeyBytes];
  if (!decode_hex(key_hex, kTransportAuthenticationKeyBytes, key)) {
    error = "transport-proof-key-invalid";
    return false;
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CCHmac(kCCHmacAlgSHA256, key, sizeof(key), canonical.data(), canonical.size(), digest);
  proof_hex = encode_hex(digest, sizeof(digest));
  std::memset(key, 0, sizeof(key));
  std::memset(digest, 0, sizeof(digest));
  return true;
}

bool verify_transport_proof(const std::string& key_hex, const std::string& canonical,
                            const std::string& proof_hex) {
  if (!is_lower_hex(proof_hex, CC_SHA256_DIGEST_LENGTH)) return false;
  std::string expected;
  std::string error;
  if (!compute_transport_proof(key_hex, canonical, expected, error)) return false;
  unsigned char expected_bytes[CC_SHA256_DIGEST_LENGTH];
  unsigned char actual_bytes[CC_SHA256_DIGEST_LENGTH];
  const bool decoded =
      decode_hex(expected, CC_SHA256_DIGEST_LENGTH, expected_bytes) &&
      decode_hex(proof_hex, CC_SHA256_DIGEST_LENGTH, actual_bytes);
  const bool equal =
      decoded && constant_time_equal(expected_bytes, actual_bytes, CC_SHA256_DIGEST_LENGTH);
  std::memset(expected_bytes, 0, sizeof(expected_bytes));
  std::memset(actual_bytes, 0, sizeof(actual_bytes));
  return equal;
}

bool parse_transport_proof_request_line(const std::string& line, size_t max_bytes,
                                        TransportProofRequest& request, std::string& error) {
  request = TransportProofRequest();
  error.clear();
  if (line.size() > max_bytes) {
    error = "authority-transport-frame-too-large";
    return false;
  }
  NSDictionary* frame = nil;
  @autoreleasepool {
    NSData* data = [NSData dataWithBytes:line.data() length:line.size()];
    NSError* json_error = nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&json_error];
    if (parsed == nil || json_error != nil || ![parsed isKindOfClass:[NSDictionary class]]) {
      error = "authority-transport-json-invalid";
      return false;
    }
    frame = static_cast<NSDictionary*>(parsed);
  }
  if (!exact_keys(frame, @[ @"schemaVersion", @"type", @"role", @"challenge", @"sourceSha256",
                            @"requestMaxBytes", @"responseMaxBytes" ])) {
    error = "authority-transport-shape-invalid";
    return false;
  }
  if (!strict_schema_version_one(frame[@"schemaVersion"])) {
    error = "authority-transport-schema-invalid";
    return false;
  }
  if (!strict_string_is(frame[@"type"], @"helper-proof-request")) {
    error = "authority-transport-type-invalid";
    return false;
  }
  TransportRole role = TransportRole::Authority;
  if (!parse_role(frame[@"role"], role)) {
    error = "authority-transport-role-invalid";
    return false;
  }
  std::string challenge;
  std::string source;
  if (!string_bytes(frame[@"challenge"], challenge) ||
      !is_valid_transport_challenge(challenge)) {
    error = "authority-transport-challenge-invalid";
    return false;
  }
  if (!string_bytes(frame[@"sourceSha256"], source) || contains_forbidden_bytes(source)) {
    error = "authority-transport-source-invalid";
    return false;
  }
  size_t request_max = 0;
  size_t response_max = 0;
  if (!bounded_integer(frame[@"requestMaxBytes"], kTransportProofMaxBoundBytes, true,
                       request_max) ||
      !bounded_integer(frame[@"responseMaxBytes"], kTransportProofMaxBoundBytes, true,
                       response_max)) {
    error = "authority-transport-bound-invalid";
    return false;
  }
  std::string canonical;
  if (!transport_proof_canonical(role, challenge, source, request_max, response_max, canonical,
                                 error)) {
    error = "authority-transport-fields-invalid";
    return false;
  }
  request.role = role;
  request.challenge_hex = std::move(challenge);
  request.source_sha256 = std::move(source);
  request.request_max_bytes = request_max;
  request.response_max_bytes = response_max;
  return true;
}

std::string serialize_transport_proof_request(TransportRole role,
                                              const std::string& challenge_hex,
                                              const std::string& source_sha256,
                                              size_t request_max_bytes,
                                              size_t response_max_bytes) {
  std::string canonical;
  std::string error;
  if (!transport_proof_canonical(role, challenge_hex, source_sha256, request_max_bytes,
                                 response_max_bytes, canonical, error)) {
    return "";
  }
  const char* role_value = role_text(role);
  NSString* challenge = [NSString stringWithUTF8String:challenge_hex.c_str()];
  NSString* source = [NSString stringWithUTF8String:source_sha256.c_str()];
  NSString* role_string = role_value == nullptr ? nil : [NSString stringWithUTF8String:role_value];
  if (challenge == nil || source == nil || role_string == nil) return "";
  return json_line(@{
    @"schemaVersion" : @1,
    @"type" : @"helper-proof-request",
    @"role" : role_string,
    @"challenge" : challenge,
    @"sourceSha256" : source,
    @"requestMaxBytes" : @(request_max_bytes),
    @"responseMaxBytes" : @(response_max_bytes),
  });
}

std::string serialize_transport_proof(TransportRole role, const std::string& challenge_hex,
                                      const std::string& proof_hex) {
  const char* role_value = role_text(role);
  if (role_value == nullptr || !is_valid_transport_challenge(challenge_hex) ||
      !is_lower_hex(proof_hex, CC_SHA256_DIGEST_LENGTH)) {
    return "";
  }
  NSString* challenge = [NSString stringWithUTF8String:challenge_hex.c_str()];
  NSString* proof = [NSString stringWithUTF8String:proof_hex.c_str()];
  NSString* role_string = [NSString stringWithUTF8String:role_value];
  if (challenge == nil || proof == nil || role_string == nil) return "";
  return json_line(@{
    @"schemaVersion" : @1,
    @"type" : @"helper-proof",
    @"role" : role_string,
    @"challenge" : challenge,
    @"proof" : proof,
  });
}

std::string serialize_transport_error(const std::string& reason) {
  if (!fixed_reason(reason)) return "";
  NSString* text = [NSString stringWithUTF8String:reason.c_str()];
  if (text == nil) return "";
  return json_line(@{
    @"schemaVersion" : @1,
    @"type" : @"helper-proof-error",
    @"reason" : text,
  });
}

bool perform_authority_transport_auth(int fd, const std::string& key_hex, int timeout_ms,
                                      const std::atomic<bool>& stop, std::string& remainder,
                                      std::string& error) {
  remainder.clear();
  error.clear();
  // 中文原因：peer 可能在 proof 前关闭；不能因 send EPIPE 触发 SIGPIPE 终止 Helper。
  int no_sigpipe = 1;
  (void)setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe));
  auto fail = [&](std::string reason) {
    // 中文原因：调用方会传 error 本身，先复制再覆盖，避免 c_str 悬空。
    error = std::move(reason);
    const std::string frame = serialize_transport_error(error);
    if (!frame.empty()) {
      std::string ignored;
      (void)send_all(fd, frame, 1'000, stop, ignored);
    }
    return false;
  };
  if (!is_valid_transport_authentication_key(key_hex)) {
    return fail("authority-transport-key-missing");
  }
  std::string line;
  std::string trailing;
  if (!read_line_preserving(fd, kTransportProofMaxFrameBytes, timeout_ms, stop, line, trailing,
                            error)) {
    return fail(error.empty() ? "authority-transport-read-failed" : error);
  }
  TransportProofRequest request;
  if (!parse_transport_proof_request_line(line, kTransportProofMaxFrameBytes, request, error)) {
    return fail(error.empty() ? "authority-transport-invalid" : error);
  }
  if (request.role != TransportRole::Authority) {
    return fail("authority-transport-role-invalid");
  }
  std::string canonical;
  std::string proof;
  if (!transport_proof_canonical(request.role, request.challenge_hex, request.source_sha256,
                                 request.request_max_bytes, request.response_max_bytes, canonical,
                                 error) ||
      !compute_transport_proof(key_hex, canonical, proof, error)) {
    return fail("authority-transport-proof-failed");
  }
  const std::string response =
      serialize_transport_proof(TransportRole::Authority, request.challenge_hex, proof);
  if (response.empty()) return fail("authority-transport-proof-failed");
  if (!send_all(fd, response, timeout_ms, stop, error)) {
    return fail(error.empty() ? "authority-transport-write-failed" : error);
  }
  remainder = std::move(trailing);
  return true;
}

}  // namespace zody::cua::desktop_session
