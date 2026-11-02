// App 内确认（W3）单测：ConfirmationController 的 App 决定入口与 supervisor 的
// confirm 帧收发等待循环。被测源是真实的 confirmation.mm / session_supervisor.mm
// （含 AuthorityFdReader 与 request_app_confirmation）；对端 CLI 用 socketpair 假
// server 回帧，不 stub 状态机本身。supervisor handle_connection 的全链路（peer
// auth/bootstrap/check/lease/capture）依赖真实进程结构，不在本文件覆盖范围。

#import <Foundation/Foundation.h>

#include <errno.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <string>
#include <thread>

#include "confirmation.h"
#include "session_binding.h"
#include "session_supervisor.h"

namespace {

using zody::cua::desktop_session::AppConfirmCancelPoll;
using zody::cua::desktop_session::AppConfirmResult;
using zody::cua::desktop_session::AppConfirmStatus;
using zody::cua::desktop_session::AuthorityFdReader;
using zody::cua::desktop_session::ConfirmationController;
using zody::cua::desktop_session::SessionBinding;
using zody::cua::desktop_session::request_app_confirmation;

int failures = 0;

void expect(bool condition, const char* message) {
  if (condition) return;
  std::fprintf(stderr, "FAIL: %s\n", message);
  failures += 1;
}

// stderr marker 捕获：log_confirmation_* 直接写 stderr；测试期间把 fd 换成 pipe，
// 恢复 stderr 后写端全部关闭，read 依 EOF 收尾不会阻塞。
class StderrCapture {
 public:
  StderrCapture() {
    if (pipe(fds_) != 0) std::exit(2);
    saved_ = dup(STDERR_FILENO);
    if (saved_ < 0 || dup2(fds_[1], STDERR_FILENO) < 0) std::exit(2);
    close(fds_[1]);
    fds_[1] = -1;
  }

  ~StderrCapture() { restore(); }

  std::string restore_and_drain() {
    restore();
    std::string out;
    char buffer[4096];
    while (true) {
      const ssize_t count = read(fds_[0], buffer, sizeof(buffer));
      if (count <= 0) break;
      out.append(buffer, static_cast<size_t>(count));
    }
    return out;
  }

 private:
  void restore() {
    if (saved_ < 0) return;
    std::fflush(nullptr);
    dup2(saved_, STDERR_FILENO);
    close(saved_);
    saved_ = -1;
  }

  int fds_[2] = {-1, -1};
  int saved_ = -1;
};

size_t count_occurrences(const std::string& haystack, const std::string& needle) {
  size_t count = 0;
  size_t position = 0;
  while ((position = haystack.find(needle, position)) != std::string::npos) {
    count += 1;
    position += needle.size();
  }
  return count;
}

SessionBinding test_binding() {
  SessionBinding binding;
  binding.trace_id = "trace-1";
  binding.producer_incarnation = "producer-1";
  binding.run_id = "run-1";
  binding.turn_id = "turn-1";
  binding.submission_lineage_id = "lineage-1";
  binding.app_incarnation = "app-1";
  binding.host_instance_id = "host-1";
  binding.runtime_instance_id = "runtime-1";
  binding.session_id = "12345678-aaaa-bbbb-cccc-1234567890ab";
  binding.workspace_key = "/tmp/workspace";
  binding.authorization_revision = 7;
  binding.target.window_id = 4242;
  binding.target.pid = 99;
  binding.target.layer = 0;
  binding.target.x = 10;
  binding.target.y = 20;
  binding.target.width = 300;
  binding.target.height = 200;
  binding.target.owner_name = "Owner";
  binding.target.window_name = "Notes";
  return binding;
}

void test_controller_app_decision() {
  const SessionBinding binding = test_binding();

  {
    // begin 登记与单活动互斥；终结后可开新一代。
    StderrCapture capture;
    ConfirmationController controller;
    const uint64_t first = controller.begin(binding);
    expect(first != 0, "begin must register a prompt");
    expect(controller.begin(binding) == 0, "second begin while pending must be rejected");
    expect(controller.resolveFromApp(first, true), "app allow must be accepted");
    const uint64_t second = controller.begin(binding);
    expect(second != 0 && second != first, "begin after resolve must allocate a new generation");
    expect(!controller.resolveFromApp(second, false), "app deny must not report accepted");
    (void)capture.restore_and_drain();
  }

  {
    // App 允许：user-approved marker。
    StderrCapture capture;
    ConfirmationController controller;
    const uint64_t generation = controller.begin(binding);
    expect(controller.resolveFromApp(generation, true), "app allow must resolve accepted");
    const std::string out = capture.restore_and_drain();
    expect(out.find("[cua-native] confirmation-presented {\"generation\":" +
                    std::to_string(generation) + "}") != std::string::npos,
           "presented marker missing");
    expect(out.find("[cua-native] confirmation-resolved {\"generation\":" +
                    std::to_string(generation) + ",\"allowed\":true,\"reason\":\"user-approved\"}") !=
               std::string::npos,
           "app allow marker missing");
  }

  {
    // App 拒绝：user-canceled marker；返回值 false 表示未放行。
    StderrCapture capture;
    ConfirmationController controller;
    const uint64_t generation = controller.begin(binding);
    expect(!controller.resolveFromApp(generation, false), "app deny must not report accepted");
    const std::string out = capture.restore_and_drain();
    expect(out.find("[cua-native] confirmation-resolved {\"generation\":" +
                    std::to_string(generation) + ",\"allowed\":false,\"reason\":\"user-canceled\"}") !=
               std::string::npos,
           "app deny marker missing");
  }

  {
    // App 允许与外部 invalidate 竞态：state machine 先锁存失效，迟到允许不得放行，
    // resolveFromApp 必须返回 false，supervisor 据此 fail-closed（不进 lease/capture）。
    StderrCapture capture;
    ConfirmationController controller;
    const uint64_t generation = controller.begin(binding);
    controller.invalidate(generation, "owner-invalidated");
    expect(!controller.resolveFromApp(generation, true),
           "late app allow after invalidate must report not accepted");
    const std::string out = capture.restore_and_drain();
    expect(out.find("\"allowed\":false,\"reason\":\"owner-invalidated\"") != std::string::npos,
           "invalidate marker missing");
    expect(out.find("user-approved") == std::string::npos,
           "late app allow after invalidate must not approve");
  }

  {
    // 重复 resolve 无副作用：只产生一条 resolved marker，第二次返回 false。
    StderrCapture capture;
    ConfirmationController controller;
    const uint64_t generation = controller.begin(binding);
    expect(controller.resolveFromApp(generation, true), "first app allow must be accepted");
    expect(!controller.resolveFromApp(generation, true), "duplicate resolve must be a no-op");
    const std::string out = capture.restore_and_drain();
    expect(count_occurrences(out, "\"reason\":\"user-approved\"") == 1,
           "duplicate resolve must be a no-op");
  }

  {
    // app-confirm-failed：CLI ok:false / 帧处理失败的固定 reason。
    StderrCapture capture;
    ConfirmationController controller;
    const uint64_t generation = controller.begin(binding);
    controller.resolveAppConfirmFailed(generation);
    const std::string out = capture.restore_and_drain();
    expect(out.find("[cua-native] confirmation-resolved {\"generation\":" +
                    std::to_string(generation) + ",\"allowed\":false,\"reason\":\"app-confirm-failed\"}") !=
               std::string::npos,
           "app-confirm-failed marker missing");
  }

  {
    // 已 resolve 后的 resolveAppConfirmFailed 是 late 调用，无副作用。
    StderrCapture capture;
    ConfirmationController controller;
    const uint64_t generation = controller.begin(binding);
    controller.resolveFromApp(generation, false);
    controller.resolveAppConfirmFailed(generation);
    const std::string out = capture.restore_and_drain();
    expect(count_occurrences(out, "\"reason\":\"user-canceled\"") == 1,
           "resolved marker must stay unique");
    expect(out.find("app-confirm-failed") == std::string::npos,
           "late app-confirm-failed must be a no-op");
  }

  {
    // cancel() 保留：外部取消沿用 deny 语义并输出透传 reason。
    StderrCapture capture;
    ConfirmationController controller;
    const uint64_t generation = controller.begin(binding);
    controller.cancel(generation, "user-canceled");
    const std::string out = capture.restore_and_drain();
    expect(out.find("\"allowed\":false,\"reason\":\"user-canceled\"") != std::string::npos,
           "cancel marker missing");
  }

  {
    // dismissAll：shutdown 收口，之后可再开新 prompt。
    StderrCapture capture;
    ConfirmationController controller;
    const uint64_t generation = controller.begin(binding);
    controller.dismissAll();
    const std::string out = capture.restore_and_drain();
    expect(out.find("\"allowed\":false,\"reason\":\"shutdown\"") != std::string::npos,
           "shutdown marker missing");
    const uint64_t next = controller.begin(binding);
    expect(next != 0 && next != generation, "begin after dismissAll must allocate a new prompt");
    expect(!controller.resolveFromApp(next, false), "deny after dismissAll must not be accepted");
    (void)capture.restore_and_drain();
  }

  {
    // 无效 binding 一律拒绝。
    StderrCapture capture;
    ConfirmationController controller;
    SessionBinding invalid;
    expect(controller.begin(invalid) == 0, "invalid binding must be rejected");
    (void)capture.restore_and_drain();
  }
}

// 假 authority 对端：socketpair 全双工；server 端可预写响应行、读请求行或关闭。
class FakeAuthorityPeer {
 public:
  FakeAuthorityPeer() {
    int fds[2] = {-1, -1};
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, fds) != 0) std::exit(2);
    client_fd_ = fds[0];
    server_fd_ = fds[1];
  }

  ~FakeAuthorityPeer() {
    close_client();
    close_server();
  }

  FakeAuthorityPeer(const FakeAuthorityPeer&) = delete;
  FakeAuthorityPeer& operator=(const FakeAuthorityPeer&) = delete;

  int client_fd() const { return client_fd_; }

  void write_line(const std::string& line) {
    if (server_fd_ < 0) return;
    const std::string bytes = line + "\n";
    size_t offset = 0;
    while (offset < bytes.size()) {
      const ssize_t count = send(server_fd_, bytes.data() + offset, bytes.size() - offset, 0);
      if (count < 0) {
        if (errno == EINTR) continue;
        return;
      }
      offset += static_cast<size_t>(count);
    }
  }

  std::string read_line(int timeout_ms) {
    while (true) {
      const size_t newline = buffer_.find('\n');
      if (newline != std::string::npos) {
        std::string line = buffer_.substr(0, newline);
        buffer_.erase(0, newline + 1);
        return line;
      }
      if (server_fd_ < 0) return {};
      struct pollfd descriptor {};
      descriptor.fd = server_fd_;
      descriptor.events = POLLIN;
      const int ready = poll(&descriptor, 1, timeout_ms);
      if (ready <= 0) return {};
      char chunk[4096];
      const ssize_t count = recv(server_fd_, chunk, sizeof(chunk), 0);
      if (count <= 0) return {};
      buffer_.append(chunk, static_cast<size_t>(count));
    }
  }

  void close_server() {
    if (server_fd_ >= 0) {
      shutdown(server_fd_, SHUT_RDWR);
      close(server_fd_);
      server_fd_ = -1;
    }
  }

  void close_client() {
    if (client_fd_ >= 0) {
      close(client_fd_);
      client_fd_ = -1;
    }
  }

 private:
  int client_fd_ = -1;
  int server_fd_ = -1;
  std::string buffer_;
};

NSDictionary* parse_json_line(const std::string& line) {
  NSData* data = [NSData dataWithBytes:line.data() length:line.size()];
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [parsed isKindOfClass:[NSDictionary class]] ? static_cast<NSDictionary*>(parsed) : nil;
}

AppConfirmResult run_request(FakeAuthorityPeer& peer, uint64_t generation,
                             const SessionBinding& binding,
                             const AppConfirmCancelPoll& poll_cancel = nullptr) {
  AuthorityFdReader reader(peer.client_fd());
  return request_app_confirmation(reader, generation, binding, poll_cancel);
}

void test_confirm_wire_and_wait() {
  const uint64_t generation = 42;
  SessionBinding binding = test_binding();
  // 展示事实清洗 fixture：只过滤控制字符（<0x20 与 0x7f），保留完整 UTF-8 与引号/反斜杠；
  // JSON 序列化负责转义，不再把非 ASCII 或引号替换成 '?'。
  binding.target.owner_name = std::string("A\x01") + "B\"C\\D";
  binding.target.window_name = "中文窗口\x7f标题";

  {
    // 帧字段完整性与 App 允许。
    FakeAuthorityPeer peer;
    peer.write_line("{\"requestId\":\"native-1\",\"result\":{\"ok\":true,\"allowed\":true}}");
    const AppConfirmResult result = run_request(peer, generation, binding);
    expect(result.status == AppConfirmStatus::Allowed, "app allow must resolve allowed");
    const std::string request_line = peer.read_line(1000);
    NSDictionary* frame = parse_json_line(request_line);
    expect(frame != nil, "confirm request line is not a JSON object");
    expect([frame[@"method"] isEqualToString:@"confirm"], "confirm method missing");
    expect([frame[@"requestId"] isEqualToString:@"native-1"], "confirm requestId unexpected");
    NSDictionary* payload = frame[@"payload"];
    expect([payload isKindOfClass:[NSDictionary class]], "confirm payload missing");
    expect([payload[@"generation"] unsignedLongLongValue] == generation,
           "confirm generation missing");
    expect([payload[@"traceId"] isEqualToString:@"trace-1"], "confirm traceId missing");
    expect([payload[@"producerIncarnation"] isEqualToString:@"producer-1"],
           "confirm producerIncarnation missing");
    expect([payload[@"runId"] isEqualToString:@"run-1"], "confirm runId missing");
    expect([payload[@"turnId"] isEqualToString:@"turn-1"], "confirm turnId missing");
    NSDictionary* ref = payload[@"ref"];
    expect([ref isKindOfClass:[NSDictionary class]], "confirm ref missing");
    expect([ref[@"sessionId"] isEqualToString:@"12345678-aaaa-bbbb-cccc-1234567890ab"],
           "confirm ref sessionId missing");
    expect([ref[@"authorizationRevision"] longLongValue] == 7,
           "confirm ref authorizationRevision missing");
    NSDictionary* target = payload[@"target"];
    expect([target isKindOfClass:[NSDictionary class]], "confirm target missing");
    expect([target[@"pid"] intValue] == 99, "confirm target pid missing");
    expect([target[@"windowId"] unsignedIntValue] == 4242, "confirm target windowId missing");
    expect([target[@"layer"] intValue] == 0, "confirm target layer missing");
    expect([target[@"x"] doubleValue] == 10, "confirm target x missing");
    expect([target[@"y"] doubleValue] == 20, "confirm target y missing");
    expect([target[@"width"] doubleValue] == 300, "confirm target width missing");
    expect([target[@"height"] doubleValue] == 200, "confirm target height missing");
    expect([target[@"ownerName"] isEqualToString:@"AB\"C\\D"],
           "confirm ownerName must keep UTF-8/quotes and strip control characters");
    expect([target[@"windowName"] isEqualToString:@"中文窗口标题"],
           "confirm windowName must keep UTF-8 and strip DEL");
  }

  {
    // 128 字节上限：42 个 3 字节汉字 = 126 字节可接受；截断不得切断 UTF-8 码点
    //（切断会让 NSString UTF-8 初始化返回 nil，JSON 序列化崩溃）。
    SessionBinding long_binding = test_binding();
    long_binding.target.owner_name = "文本编辑";
    std::string long_name;
    for (int index = 0; index < 50; ++index) long_name += "窗";  // 150 UTF-8 bytes
    long_binding.target.window_name = long_name;

    FakeAuthorityPeer peer;
    peer.write_line("{\"requestId\":\"native-1\",\"result\":{\"ok\":true,\"allowed\":true}}");
    const AppConfirmResult result = run_request(peer, generation, long_binding);
    expect(result.status == AppConfirmStatus::Allowed, "long-name allow must resolve allowed");
    const std::string long_request_line = peer.read_line(1000);
    NSDictionary* frame = parse_json_line(long_request_line);
    NSDictionary* target = frame[@"payload"][@"target"];
    std::string expected_window;
    for (int index = 0; index < 42; ++index) expected_window += "窗";  // 126 bytes
    expect([target[@"windowName"] isEqualToString:[NSString stringWithUTF8String:expected_window.c_str()]],
           "long windowName must be truncated at 42 whole UTF-8 code points (126 bytes)");
    expect([target[@"ownerName"] isEqualToString:@"文本编辑"],
           "short UTF-8 ownerName must be kept");
  }

  {
    // 无标题窗口：空串必须原样保留（UI 按缺失行处理），不能拒绝或替换成 '?'。
    SessionBinding empty_binding = test_binding();
    empty_binding.target.owner_name = "";
    empty_binding.target.window_name = "";

    FakeAuthorityPeer peer;
    peer.write_line("{\"requestId\":\"native-1\",\"result\":{\"ok\":true,\"allowed\":true}}");
    const AppConfirmResult result = run_request(peer, generation, empty_binding);
    expect(result.status == AppConfirmStatus::Allowed, "empty-name allow must resolve allowed");
    NSDictionary* frame = parse_json_line(peer.read_line(1000));
    NSDictionary* target = frame[@"payload"][@"target"];
    expect([target[@"ownerName"] isEqualToString:@""], "empty ownerName must stay empty");
    expect([target[@"windowName"] isEqualToString:@""], "empty windowName must stay empty");
  }

  {
    // App 拒绝。
    FakeAuthorityPeer peer;
    peer.write_line("{\"requestId\":\"native-1\",\"result\":{\"ok\":true,\"allowed\":false}}");
    const AppConfirmResult result = run_request(peer, generation, binding);
    expect(result.status == AppConfirmStatus::Denied, "app deny must resolve denied");
  }

  {
    // CLI ok:false 一律 fail-closed。
    FakeAuthorityPeer peer;
    peer.write_line(
        "{\"requestId\":\"native-1\",\"result\":{\"ok\":false,\"reason\":\"confirmation-duplicate\"}}");
    const AppConfirmResult result = run_request(peer, generation, binding);
    expect(result.status == AppConfirmStatus::Failed, "ok:false must fail closed");
  }

  {
    // allowed 非精确 bool（字符串）必须 fail-closed，不能被 boolValue 宽松解释。
    FakeAuthorityPeer peer;
    peer.write_line("{\"requestId\":\"native-1\",\"result\":{\"ok\":true,\"allowed\":\"true\"}}");
    const AppConfirmResult result = run_request(peer, generation, binding);
    expect(result.status == AppConfirmStatus::Failed, "non-boolean allowed must fail closed");
  }

  {
    // result 非 dict 一律 fail-closed。
    FakeAuthorityPeer peer;
    peer.write_line("{\"requestId\":\"native-1\",\"result\":\"yes\"}");
    const AppConfirmResult result = run_request(peer, generation, binding);
    expect(result.status == AppConfirmStatus::Failed, "non-object result must fail closed");
  }

  {
    // owner revoked：既有取消路径。
    FakeAuthorityPeer peer;
    peer.write_line("{\"method\":\"revoked\"}");
    const AppConfirmResult result = run_request(peer, generation, binding);
    expect(result.status == AppConfirmStatus::Canceled, "revoked must cancel");
    expect(result.reason == "owner-invalidated", "revoked cancel reason mismatch");
  }

  {
    // requestId 不匹配：unexpected-authority-frame 取消。
    FakeAuthorityPeer peer;
    peer.write_line("{\"requestId\":\"native-99\",\"result\":{\"ok\":true,\"allowed\":true}}");
    const AppConfirmResult result = run_request(peer, generation, binding);
    expect(result.status == AppConfirmStatus::Canceled, "mismatched frame must cancel");
    expect(result.reason == "unexpected-authority-frame", "mismatched frame reason mismatch");
  }

  {
    // 非 JSON 行：帧处理失败取消。
    FakeAuthorityPeer peer;
    peer.write_line("not-json");
    const AppConfirmResult result = run_request(peer, generation, binding);
    expect(result.status == AppConfirmStatus::Canceled, "malformed frame must cancel");
    expect(result.reason.find("JSON") != std::string::npos,
           "malformed frame reason must mention JSON");
  }

  {
    // 连接终止（EOF）：帧已发出、对端在等待阶段关闭，authority-eof 收口，
    // 迟到允许不触发截图。
    FakeAuthorityPeer peer;
    std::thread server([&peer] {
      // 先让 confirm 帧完成发送；若对端在发送前已死，send 会走 EPIPE 的
      // app-confirm-failed fail-closed 路径，与本场景要验证的 EOF 分支不同。
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      peer.close_server();
    });
    const AppConfirmResult result = run_request(peer, generation, binding);
    server.join();
    expect(result.status == AppConfirmStatus::Canceled, "eof must cancel");
    expect(result.reason == "authority-eof", "eof cancel reason mismatch");
  }

  {
    // stop/取消源立即触发：沿用 wait_for_decision 的取消语义收口。
    FakeAuthorityPeer peer;
    const AppConfirmResult result =
        run_request(peer, generation, binding, [](std::string& reason) {
          reason = "session-stopped-test";
          return true;
        });
    expect(result.status == AppConfirmStatus::Canceled, "stop must cancel");
    expect(result.reason == "session-stopped-test", "stop reason must be propagated");
  }

  {
    // 响应跨多个 250ms 片到达：无固定 deadline，仍正常收口。
    FakeAuthorityPeer peer;
    std::thread server([&peer] {
      std::this_thread::sleep_for(std::chrono::milliseconds(400));
      peer.write_line("{\"requestId\":\"native-1\",\"result\":{\"ok\":true,\"allowed\":true}}");
    });
    const AppConfirmResult result = run_request(peer, generation, binding);
    server.join();
    expect(result.status == AppConfirmStatus::Allowed,
           "late-arriving response across slices must still resolve");
  }

  {
    // 等待期间取消轮询确实被周期调用，但不误吞响应。
    FakeAuthorityPeer peer;
    peer.write_line("{\"requestId\":\"native-1\",\"result\":{\"ok\":true,\"allowed\":true}}");
    int poll_calls = 0;
    const AppConfirmResult result = run_request(
        peer, generation, binding,
        [&poll_calls](std::string&) {
          poll_calls += 1;
          return false;
        });
    expect(result.status == AppConfirmStatus::Allowed, "cancel poll must not swallow response");
    expect(poll_calls >= 1, "cancel poll must run during the wait loop");
  }
}

}  // namespace

int main() {
  @autoreleasepool {
    test_controller_app_decision();
    test_confirm_wire_and_wait();
  }
  if (failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", failures);
    return 1;
  }
  std::printf("ok confirmation-app-decision\n");
  return 0;
}
