#import <Foundation/Foundation.h>

#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>

#include "session_transport_auth.h"

namespace {

using zody::cua::desktop_session::TransportRole;
using zody::cua::desktop_session::compute_transport_proof;
using zody::cua::desktop_session::is_valid_transport_authentication_key;
using zody::cua::desktop_session::is_valid_transport_challenge;
using zody::cua::desktop_session::parse_transport_proof_request_line;
using zody::cua::desktop_session::perform_authority_transport_auth;
using zody::cua::desktop_session::serialize_transport_proof;
using zody::cua::desktop_session::serialize_transport_proof_request;
using zody::cua::desktop_session::transport_proof_canonical;
using zody::cua::desktop_session::verify_transport_proof;

int failures = 0;

void expect(bool condition, const char* message) {
  if (condition) return;
  std::fprintf(stderr, "FAIL: %s\n", message);
  failures += 1;
}

const char* kKey =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const char* kChallenge =
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";
const char* kSource =
    "abababababababababababababababababababababababababababababababab";
const char* kCellCanonical =
    "zody.cua.desktop-session.transport.helper-proof|1|cell|"
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f|"
    "abababababababababababababababababababababababababababababababab|"
    "1048576|33554432";
const char* kCellProof =
    "48277697171fa3dba2d07f79c6742298911db86b7547829279bfbc6ab05e262a";
const char* kAuthorityCanonical =
    "zody.cua.desktop-session.transport.helper-proof|1|authority|"
    "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f||0|0";
const char* kAuthorityProof =
    "b66d931b52624486cee1255b526da92ef8f3e3f94e0474311de38a9f4ab8dd06";
const char* kAuthorityChallenge =
    "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f";

void test_shared_vector() {
  std::string canonical;
  std::string error;
  expect(transport_proof_canonical(TransportRole::Cell, kChallenge, kSource, 1024 * 1024,
                                   32 * 1024 * 1024, canonical, error),
         "cell canonical rejected");
  expect(canonical == kCellCanonical, "cell canonical mismatch");

  std::string proof;
  expect(compute_transport_proof(kKey, canonical, proof, error), "cell proof failed");
  expect(proof == kCellProof, "cell proof does not match Node/CommonCrypto vector");
  expect(verify_transport_proof(kKey, canonical, proof), "valid cell proof rejected");

  expect(transport_proof_canonical(TransportRole::Authority, kAuthorityChallenge, "", 0, 0,
                                   canonical, error),
         "authority canonical rejected");
  expect(canonical == kAuthorityCanonical, "authority canonical mismatch");
  expect(compute_transport_proof(kKey, canonical, proof, error), "authority proof failed");
  expect(proof == kAuthorityProof, "authority proof does not match Node/CommonCrypto vector");
}

std::string replace_once(std::string value, const std::string& from, const std::string& to) {
  const size_t position = value.find(from);
  if (position == std::string::npos) return value;
  value.replace(position, from.size(), to);
  return value;
}

void test_proof_frame_shapes() {
  const std::string authority =
      serialize_transport_proof_request(TransportRole::Authority, kAuthorityChallenge, "", 0, 0);
  expect(!authority.empty(), "authority proof request serialization failed");
  zody::cua::desktop_session::TransportProofRequest request;
  std::string error;
  expect(parse_transport_proof_request_line(authority, 16 * 1024, request, error),
         "authority proof request rejected");
  expect(request.role == TransportRole::Authority, "authority role mismatch");
  expect(request.challenge_hex == kAuthorityChallenge, "authority challenge mismatch");
  expect(request.source_sha256.empty() && request.request_max_bytes == 0 &&
             request.response_max_bytes == 0,
         "authority fields mismatch");

  const std::string cell = serialize_transport_proof_request(
      TransportRole::Cell, kChallenge, kSource, 1024 * 1024, 32 * 1024 * 1024);
  expect(!cell.empty(), "cell proof request serialization failed");
  expect(parse_transport_proof_request_line(cell, 16 * 1024, request, error),
         "cell proof request rejected");
  expect(request.role == TransportRole::Cell && request.source_sha256 == kSource,
         "cell proof request fields mismatch");

  const std::string proof = serialize_transport_proof(TransportRole::Authority,
                                                      kAuthorityChallenge, kAuthorityProof);
  expect(proof.find("\"type\":\"helper-proof\"") != std::string::npos, "proof type missing");
  expect(proof.find(std::string("\"role\":\"authority\"")) != std::string::npos,
         "proof role missing");
  expect(proof.find(kAuthorityProof) != std::string::npos, "proof value missing");

  const std::pair<std::string, std::string> replacements[] = {
      {R"("schemaVersion":1)", R"("schemaVersion":true)"},
      {R"("schemaVersion":1)", R"("schemaVersion":"1")"},
      {R"("type":"helper-proof-request")", R"("type":1)"},
      {R"("type":"helper-proof-request")", R"("type":"cell-open")"},
      {R"("role":"authority")", R"("role":1)"},
      {R"("role":"authority")", R"("role":true)"},
      {R"("role":"authority")", R"("role":"admin")"},
      {R"("challenge":")" + std::string(kAuthorityChallenge) + R"(")",
       R"("challenge":true)"},
      {R"("challenge":")" + std::string(kAuthorityChallenge) + R"(")",
       R"("challenge":"short")"},
      {R"("challenge":")" + std::string(kAuthorityChallenge) + R"(")",
       R"("challenge":")" + std::string(64, 'A') + R"(")"},
      {R"("sourceSha256":"")", R"("sourceSha256":")" + std::string(64, 'a') + R"(")"},
      {R"("requestMaxBytes":0)", R"("requestMaxBytes":true)"},
      {R"("requestMaxBytes":0)", R"("requestMaxBytes":"0")"},
      {R"("requestMaxBytes":0)", R"("requestMaxBytes":1)"},
      {R"("requestMaxBytes":0)", R"("requestMaxBytes":1e400)"},
      {R"("responseMaxBytes":0)", R"("responseMaxBytes":1)"},
  };
  for (const auto& replacement : replacements) {
    const std::string malformed = replace_once(authority, replacement.first, replacement.second);
    expect(malformed != authority, "malformed proof request replacement did not apply");
    expect(!parse_transport_proof_request_line(malformed, 16 * 1024, request, error),
           "malformed proof request accepted");
  }
  std::string extra = authority;
  extra.insert(extra.size() - 1, R"(,"extra":1)");
  expect(!parse_transport_proof_request_line(extra, 16 * 1024, request, error),
         "extra proof request key accepted");
  std::string missing = authority;
  const std::string missing_key = R"(,"responseMaxBytes":0)";
  missing.replace(missing.find(missing_key), missing_key.size(), "");
  expect(!parse_transport_proof_request_line(missing, 16 * 1024, request, error),
         "missing proof request key accepted");
  expect(!parse_transport_proof_request_line(authority, 16, request, error),
         "oversized proof request accepted");
  for (const char* payload : {"", "{}", "[]", "null", "\"helper-proof-request\""}) {
    expect(!parse_transport_proof_request_line(payload, 16 * 1024, request, error),
           "non-object proof request accepted");
  }
}

bool read_line_fd(int fd, std::string& line) {
  line.clear();
  while (true) {
    char character = 0;
    const ssize_t count = recv(fd, &character, 1, 0);
    if (count == 0) return false;
    if (count < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    if (character == '\n') return true;
    line.push_back(character);
    if (line.size() > 16 * 1024) return false;
  }
}

bool write_all_fd(int fd, const std::string& bytes) {
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t count = send(fd, bytes.data() + offset, bytes.size() - offset, 0);
    if (count < 0) {
      if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue;
      return false;
    }
    if (count == 0) return false;
    offset += static_cast<size_t>(count);
  }
  return true;
}

NSDictionary* parse_json_object(const std::string& line) {
  NSData* data = [NSData dataWithBytes:line.data() length:line.size()];
  NSError* error = nil;
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (value == nil || error != nil || ![value isKindOfClass:[NSDictionary class]]) return nil;
  return static_cast<NSDictionary*>(value);
}

std::string string_field(NSDictionary* frame, NSString* key) {
  id value = frame[key];
  if (![value isKindOfClass:[NSString class]]) return "";
  NSData* data = [static_cast<NSString*>(value) dataUsingEncoding:NSUTF8StringEncoding
                                              allowLossyConversion:NO];
  if (data == nil) return "";
  return std::string(static_cast<const char*>(data.bytes), data.length);
}

void test_authority_handshake_preserves_trailing_bytes() {
  int fds[2] = {-1, -1};
  expect(socketpair(AF_UNIX, SOCK_STREAM, 0, fds) == 0, "socketpair failed");
  if (fds[0] < 0) return;
  int no_sigpipe = 1;
  (void)setsockopt(fds[0], SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe));
  const std::string trailing = R"({"bootstrap":true})" "\n";
  std::atomic<bool> stop{false};
  std::string client_error;
  std::thread client([&] {
    const std::string request = serialize_transport_proof_request(
        TransportRole::Authority, kAuthorityChallenge, "", 0, 0);
    if (!write_all_fd(fds[0], request + trailing)) {
      client_error = "client write failed";
      return;
    }
    std::string line;
    if (!read_line_fd(fds[0], line)) {
      client_error = "client proof read failed";
      return;
    }
    NSDictionary* frame = parse_json_object(line);
    if (frame == nil || string_field(frame, @"role") != "authority" ||
        string_field(frame, @"challenge") != kAuthorityChallenge) {
      client_error = "client proof shape mismatch";
      return;
    }
    std::string canonical;
    std::string error;
    if (!transport_proof_canonical(TransportRole::Authority, kAuthorityChallenge, "", 0, 0,
                                   canonical, error) ||
        !verify_transport_proof(kKey, canonical, string_field(frame, @"proof"))) {
      client_error = "client proof verification failed";
    }
  });
  std::string remainder;
  std::string error;
  const bool ok =
      perform_authority_transport_auth(fds[1], kKey, 2'000, stop, remainder, error);
  client.join();
  expect(ok, "authority handshake failed");
  expect(error.empty(), "authority handshake returned error");
  expect(remainder == trailing, "same-packet bootstrap bytes were not preserved");
  expect(client_error.empty(), "authority proof verification failed");
  close(fds[0]);
  close(fds[1]);
}

void test_authority_handshake_rejects_wrong_role_and_key() {
  {
    int fds[2] = {-1, -1};
    expect(socketpair(AF_UNIX, SOCK_STREAM, 0, fds) == 0, "role socketpair failed");
    if (fds[0] < 0) return;
    int no_sigpipe = 1;
    (void)setsockopt(fds[1], SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe));
    std::atomic<bool> stop{false};
    std::thread client([&] {
      (void)write_all_fd(
          fds[0], serialize_transport_proof_request(TransportRole::Cell, kChallenge, kSource, 1, 1));
      (void)shutdown(fds[0], SHUT_WR);
    });
    std::string remainder;
    std::string error;
    const bool ok =
        perform_authority_transport_auth(fds[1], kKey, 2'000, stop, remainder, error);
    client.join();
    expect(!ok, "cell role accepted on authority endpoint");
    expect(error.find("role") != std::string::npos, "wrong-role error not explicit");
    close(fds[0]);
    close(fds[1]);
  }
  {
    int fds[2] = {-1, -1};
    expect(socketpair(AF_UNIX, SOCK_STREAM, 0, fds) == 0, "key socketpair failed");
    if (fds[0] < 0) return;
    std::atomic<bool> stop{false};
    std::string remainder;
    std::string error;
    const bool ok = perform_authority_transport_auth(
        fds[1], std::string(64, '0'), 2'000, stop, remainder, error);
    expect(!ok, "all-zero key accepted");
    expect(!error.empty(), "missing-key error not reported");
    close(fds[0]);
    close(fds[1]);
  }
}

void test_cross_role_and_replay_rejected() {
  std::string authority_canonical;
  std::string cell_canonical;
  std::string error;
  expect(transport_proof_canonical(TransportRole::Authority, kAuthorityChallenge, "", 0, 0,
                                   authority_canonical, error),
         "authority canonical setup failed");
  expect(transport_proof_canonical(TransportRole::Cell, kChallenge, kSource, 1, 1,
                                   cell_canonical, error),
         "cell canonical setup failed");
  std::string authority_proof;
  expect(compute_transport_proof(kKey, authority_canonical, authority_proof, error),
         "authority proof setup failed");
  expect(!verify_transport_proof(kKey, cell_canonical, authority_proof),
         "authority proof accepted as cell proof");
  const std::string other_challenge =
      "505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f";
  std::string replayed_canonical;
  expect(transport_proof_canonical(TransportRole::Authority, other_challenge, "", 0, 0,
                                   replayed_canonical, error),
         "replay canonical setup failed");
  expect(!verify_transport_proof(kKey, replayed_canonical, authority_proof),
         "replayed proof accepted for a fresh challenge");
}

void test_rejects_bad_inputs_and_cross_role_replay() {
  std::string canonical;
  std::string error;
  expect(!transport_proof_canonical(TransportRole::Cell, kChallenge, "", 1, 1, canonical, error),
         "cell without source accepted");
  expect(!transport_proof_canonical(TransportRole::Cell, kChallenge, kSource, 0, 1, canonical,
                                    error),
         "cell zero request bound accepted");
  expect(!transport_proof_canonical(TransportRole::Authority, kChallenge, kSource, 0, 0,
                                    canonical, error),
         "authority with source accepted");
  expect(!transport_proof_canonical(TransportRole::Authority, kChallenge, "", 1, 0, canonical,
                                    error),
         "authority with bound accepted");
  expect(!is_valid_transport_authentication_key(
             "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
         "uppercase key accepted");
  expect(!is_valid_transport_authentication_key(std::string(63, 'a')), "short key accepted");
  expect(!is_valid_transport_challenge(std::string(64, 'z')), "non-hex challenge accepted");

  std::string cell;
  std::string authority;
  std::string proof;
  expect(transport_proof_canonical(TransportRole::Cell, kChallenge, kSource, 1, 1, cell, error),
         "cell canonical setup failed");
  expect(transport_proof_canonical(TransportRole::Authority,
                                   "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f",
                                   "", 0, 0, authority, error),
         "authority canonical setup failed");
  expect(compute_transport_proof(kKey, cell, proof, error), "cell proof setup failed");
  expect(!verify_transport_proof(kKey, authority, proof), "cross-role proof accepted");
  expect(!verify_transport_proof(kKey, cell, std::string(64, '0')), "wrong proof accepted");
  expect(!verify_transport_proof(kKey, cell, proof.substr(0, 63)), "truncated proof accepted");
}

void test_generates_key() {
  std::string key;
  expect(zody::cua::desktop_session::generate_transport_authentication_key(key),
         "key generation failed");
  expect(is_valid_transport_authentication_key(key), "generated key invalid");
  expect(key != std::string(64, '0'), "all-zero key generated");
}

}  // namespace

int main() {
  @autoreleasepool {
    test_shared_vector();
    test_rejects_bad_inputs_and_cross_role_replay();
    test_proof_frame_shapes();
    test_authority_handshake_preserves_trailing_bytes();
    test_authority_handshake_rejects_wrong_role_and_key();
    test_cross_role_and_replay_rejected();
    test_generates_key();
  }
  if (failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", failures);
    return 1;
  }
  std::printf("session-transport-auth: pass\n");
  return 0;
}
