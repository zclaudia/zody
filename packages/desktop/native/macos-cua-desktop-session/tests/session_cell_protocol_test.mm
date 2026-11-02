#import <Foundation/Foundation.h>

#include <cstdio>
#include <string>

#include "session_cell_protocol.h"

namespace {

using zody::cua::desktop_session::CellOpenRequest;
using zody::cua::desktop_session::is_fixed_cell_reason;
using zody::cua::desktop_session::parse_cell_open_line;
using zody::cua::desktop_session::serialize_cell_error;
using zody::cua::desktop_session::serialize_cell_exit;
using zody::cua::desktop_session::serialize_cell_ready;

int failures = 0;

void expect(bool condition, const char* message) {
  if (condition) return;
  std::fprintf(stderr, "FAIL: %s\n", message);
  failures += 1;
}

const std::string kChallenge = std::string(64, 'c');
const std::string kProof = std::string(64, 'd');

std::string valid_open() {
  return R"({"schemaVersion":1,"type":"cell-open","sourceSha256":")" + std::string(64, 'a') +
         R"(","challenge":")" + kChallenge +
         R"(","requestMaxBytes":1048576,"responseMaxBytes":33554432})";
}

void test_valid_open() {
  CellOpenRequest request;
  std::string error;
  expect(parse_cell_open_line(valid_open(), 16 * 1024, request, error), "valid open rejected");
  expect(request.source_sha256 == std::string(64, 'a'), "source sha mismatch");
  expect(request.challenge_hex == kChallenge, "challenge mismatch");
  expect(request.request_max_bytes == 1024 * 1024, "request bound mismatch");
  expect(request.response_max_bytes == 32 * 1024 * 1024, "response bound mismatch");
}

void test_open_rejections() {
  CellOpenRequest request;
  std::string error;
  expect(!parse_cell_open_line(valid_open() + "x", 16 * 1024, request, error),
         "trailing byte accepted");

  std::string extra = valid_open();
  extra.insert(extra.size() - 1, R"(,"extra":1)");
  expect(!parse_cell_open_line(extra, 16 * 1024, request, error), "extra key accepted");

  std::string missing = valid_open();
  const std::string key = R"(,"responseMaxBytes":33554432)";
  missing.replace(missing.find(key), key.size(), "");
  expect(!parse_cell_open_line(missing, 16 * 1024, request, error), "missing key accepted");

  std::string uppercase = valid_open();
  uppercase[uppercase.find(std::string(64, 'a'))] = 'A';
  expect(!parse_cell_open_line(uppercase, 16 * 1024, request, error), "uppercase sha accepted");

  std::string short_sha = valid_open();
  short_sha.replace(short_sha.find(std::string(64, 'a')), 64, std::string(63, 'a'));
  expect(!parse_cell_open_line(short_sha, 16 * 1024, request, error), "short sha accepted");

  for (const char* bound : {R"("requestMaxBytes":0)", R"("requestMaxBytes":1048577)",
                            R"("responseMaxBytes":1.5)", R"("responseMaxBytes":33554433)"}) {
    std::string invalid = valid_open();
    const std::string original =
        std::string(bound).rfind("request", 1) == 0 ? R"("requestMaxBytes":1048576)"
                                                    : R"("responseMaxBytes":33554432)";
    invalid.replace(invalid.find(original), original.size(), bound);
    expect(!parse_cell_open_line(invalid, 16 * 1024, request, error),
           "invalid numeric bound accepted");
  }

  expect(!parse_cell_open_line(valid_open(), 16, request, error), "oversized frame accepted");
}

std::string replace_once(std::string value, const std::string& from, const std::string& to) {
  const size_t position = value.find(from);
  if (position == std::string::npos) return value;
  value.replace(position, from.size(), to);
  return value;
}

void test_malformed_types_are_rejected() {
  CellOpenRequest request;
  std::string error;
  const std::string base = valid_open();
  const std::pair<std::string, std::string> replacements[] = {
      {R"("schemaVersion":1)", R"("schemaVersion":true)"},
      {R"("schemaVersion":1)", R"("schemaVersion":false)"},
      {R"("schemaVersion":1)", R"("schemaVersion":"1")"},
      {R"("schemaVersion":1)", R"("schemaVersion":null)"},
      {R"("schemaVersion":1)", R"("schemaVersion":[1])"},
      {R"("schemaVersion":1)", "\"schemaVersion\":{}"},
      {R"("type":"cell-open")", R"("type":1)"},
      {R"("type":"cell-open")", R"("type":true)"},
      {R"("type":"cell-open")", "\"type\":{}"},
      {R"("type":"cell-open")", R"("type":["cell-open"])"},
      {R"("challenge":")" + kChallenge + R"(")", R"("challenge":true)"},
      {R"("challenge":")" + kChallenge + R"(")", R"("challenge":"short")"},
      {R"("challenge":")" + kChallenge + R"(")", R"("challenge":")" + std::string(64, 'C') + R"(")"},
      {R"("challenge":")" + kChallenge + R"(")", R"("challenge":")" + std::string(64, 'z') + R"(")"},
      {R"("requestMaxBytes":1048576)", R"("requestMaxBytes":true)"},
      {R"("requestMaxBytes":1048576)", R"("requestMaxBytes":"1048576")"},
      {R"("requestMaxBytes":1048576)", R"("requestMaxBytes":null)"},
      {R"("requestMaxBytes":1048576)", R"("requestMaxBytes":[1048576])"},
      {R"("requestMaxBytes":1048576)", R"("requestMaxBytes":1048576.5)"},
      {R"("requestMaxBytes":1048576)", R"("requestMaxBytes":-1)"},
      {R"("requestMaxBytes":1048576)", R"("requestMaxBytes":1e400)"},
      {R"("responseMaxBytes":33554432)", R"("responseMaxBytes":false)"},
      {R"("responseMaxBytes":33554432)", R"("responseMaxBytes":33554432.5)"},
      {R"("responseMaxBytes":33554432)", R"("responseMaxBytes":0)"},
  };
  for (const auto& replacement : replacements) {
    const std::string payload = replace_once(base, replacement.first, replacement.second);
    expect(payload != base, "malformed replacement did not apply");
    expect(!parse_cell_open_line(payload, 16 * 1024, request, error),
           "malformed field type/value accepted");
  }
  for (const char* payload : {"", "{}", "[]", "null", "\"cell-open\"", "{\"schemaVersion\":1"}) {
    expect(!parse_cell_open_line(payload, 16 * 1024, request, error),
           "non-object or truncated json accepted");
  }
}

void test_serializers() {
  const std::string ready = serialize_cell_ready(4321);
  expect(ready.find("\"cellPid\":4321") != std::string::npos, "ready frame missing pid");
  expect(ready.find("\"challenge\"") == std::string::npos, "ready frame leaked challenge");
  expect(ready.find("\"proof\"") == std::string::npos, "ready frame leaked proof");
  expect(serialize_cell_ready(0).empty(), "invalid pid serialized");
  expect(serialize_cell_error("cell-identity-failed").find("cell-identity-failed") !=
             std::string::npos,
         "error frame mismatch");
  expect(serialize_cell_error("bad\nreason").empty(), "control char reason serialized");
  expect(is_fixed_cell_reason("cell-slot-busy"), "fixed reason rejected");
  expect(!is_fixed_cell_reason(std::string(300, 'a')), "oversized reason accepted");
  const std::string exited = serialize_cell_exit(true, true, 0, false, 0);
  expect(exited.find("\"exitCode\":0") != std::string::npos &&
             exited.find("\"signal\":null") != std::string::npos,
         "exit frame mismatch");
  const std::string signaled = serialize_cell_exit(true, false, 0, true, 9);
  expect(signaled.find("\"signal\":9") != std::string::npos &&
             signaled.find("\"exitCode\":null") != std::string::npos,
         "signal frame mismatch");
}

}  // namespace

int main() {
  @autoreleasepool {
    test_valid_open();
    test_open_rejections();
    test_malformed_types_are_rejected();
    test_serializers();
  }
  if (failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", failures);
    return 1;
  }
  std::printf("session-cell-protocol: pass\n");
  return 0;
}
