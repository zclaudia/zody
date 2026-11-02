#include "authority_client.h"

#include <errno.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstring>
#include <string>

namespace zody::cua::round11 {
namespace {

constexpr size_t kMaxLineBytes = 16 * 1024;
constexpr size_t kMaxPendingRequests = 32;
constexpr int kIoTimeoutMs = 10'000;

bool parse_line(const std::string& line, NSDictionary** frame) {
  NSData* data = [NSData dataWithBytes:line.data() length:line.size()];
  NSError* error = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (parsed == nil || ![parsed isKindOfClass:[NSDictionary class]]) return false;
  *frame = static_cast<NSDictionary*>(parsed);
  return true;
}

std::string request_id_of(NSDictionary* frame) {
  id value = frame[@"requestId"];
  if (![value isKindOfClass:[NSString class]]) return "";
  return std::string([static_cast<NSString*>(value) UTF8String]);
}

std::string method_of(NSDictionary* frame) {
  id value = frame[@"method"];
  if (![value isKindOfClass:[NSString class]]) return "";
  return std::string([static_cast<NSString*>(value) UTF8String]);
}

bool wait_fd(int fd, short events, int timeout_ms) {
  struct pollfd descriptor {};
  descriptor.fd = fd;
  descriptor.events = events;
  const int result = poll(&descriptor, 1, timeout_ms);
  if (result <= 0) return false;
  return (descriptor.revents & events) != 0;
}

bool send_deadline(int fd, const std::string& bytes, std::string& error) {
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(kIoTimeoutMs);
  size_t offset = 0;
  while (offset < bytes.size()) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                               deadline - std::chrono::steady_clock::now())
                               .count();
    if (remaining <= 0) {
      error = "authority write timed out";
      return false;
    }
    if (!wait_fd(fd, POLLOUT, static_cast<int>(remaining))) {
      error = "authority write timed out";
      return false;
    }
    const ssize_t count =
        send(fd, bytes.data() + offset, bytes.size() - offset, MSG_NOSIGNAL | MSG_DONTWAIT);
    if (count < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
      error = std::string("authority write failed: ") + std::strerror(errno);
      return false;
    }
    offset += static_cast<size_t>(count);
  }
  return true;
}


}  // namespace

AuthorityClient::~AuthorityClient() { close(); }

bool AuthorityClient::start(std::function<void(const std::string&)> on_revocation,
                            std::function<void(const std::string&)> on_closed,
                            std::string& error) {
  if (fd_.load() < 0) {
    error = "authority fd unavailable";
    return false;
  }
  on_revocation_ = std::move(on_revocation);
  on_closed_ = std::move(on_closed);
  reader_ = std::thread([this] { reader_loop(); });
  return true;
}

void AuthorityClient::interrupt() {
  const int fd = fd_.load();
  if (fd >= 0) (void)shutdown(fd, SHUT_RDWR);
}

void AuthorityClient::close() {
  bool first = false;
  {
    std::lock_guard<std::mutex> lock(state_mutex_);
    if (!close_started_) {
      close_started_ = true;
      first = true;
    }
  }
  if (!first) {
    std::unique_lock<std::mutex> lock(state_mutex_);
    state_changed_.wait_for(lock, std::chrono::seconds(12), [this] { return closed_; });
    return;
  }

  const int fd = fd_.load();
  if (fd >= 0) (void)shutdown(fd, SHUT_RDWR);
  if (reader_.joinable() && reader_.get_id() != std::this_thread::get_id()) {
    reader_.join();
  }
  const int closing = fd_.exchange(-1);
  if (closing >= 0) ::close(closing);
  {
    std::lock_guard<std::mutex> lock(state_mutex_);
    closed_ = true;
  }
  state_changed_.notify_all();
}

bool AuthorityClient::write_all(const std::string& bytes, std::string& error) {
  const int fd = fd_.load();
  if (fd < 0) {
    error = "authority channel is closed";
    return false;
  }
  std::lock_guard<std::mutex> lock(write_mutex_);
  return send_deadline(fd, bytes, error);
}

void AuthorityClient::reader_loop() {
  std::string buffer;
  std::string close_reason = "authority-eof";
  bool fatal = false;
  while (!fatal) {
    char chunk[4096];
    const int fd = fd_.load();
    if (fd < 0) break;
    const ssize_t count = recv(fd, chunk, sizeof(chunk), 0);
    if (count < 0) {
      if (errno == EINTR) continue;
      close_reason = std::string("authority-read-error: ") + std::strerror(errno);
      break;
    }
    if (count == 0) break;
    buffer.append(chunk, static_cast<size_t>(count));
    size_t newline = buffer.find('\n');
    while (newline != std::string::npos) {
      std::string line = buffer.substr(0, newline);
      buffer.erase(0, newline + 1);
      if (!line.empty()) {
        if (line.size() > kMaxLineBytes) {
          close_reason = "authority-line-too-large";
          fatal = true;
          break;
        }
        NSDictionary* frame = nil;
        if (!parse_line(line, &frame)) {
          // 中文原因：解析失败必须终止整个 reader，不能只跳出内层循环后继续
          // 把损坏的协议流当成正常响应。
          close_reason = "authority-invalid-json";
          fatal = true;
          break;
        }
        const std::string method = method_of(frame);
        if (method == "revoked") {
          if (on_revocation_) on_revocation_(line);
        } else {
          const std::string request_id = request_id_of(frame);
          std::lock_guard<std::mutex> lock(state_mutex_);
          // 只接受本客户端尚未完成的 requestId；未知/重复 response 视为协议
          // 污染并关闭，避免 responses_ 无界增长。
          if (request_id.empty() || pending_.count(request_id) == 0 ||
              responses_.size() >= kMaxPendingRequests) {
            close_reason = "authority-unexpected-response";
            fatal = true;
            break;
          }
          responses_[request_id] = line;
          pending_.erase(request_id);
          state_changed_.notify_all();
        }
      }
      newline = buffer.find('\n');
    }
    if (!fatal && buffer.size() > kMaxLineBytes) {
      close_reason = "authority-line-too-large";
      fatal = true;
    }
  }
  {
    std::lock_guard<std::mutex> lock(state_mutex_);
    closed_ = true;
    state_changed_.notify_all();
  }
  if (on_closed_) on_closed_(close_reason);
}

bool AuthorityClient::request(NSString* method, NSDictionary* payload, NSDictionary** result,
                              std::string& error) {
  if (result != nullptr) *result = nil;
  std::string request_id;
  {
    std::lock_guard<std::mutex> lock(state_mutex_);
    if (closed_) {
      error = "authority channel is closed";
      return false;
    }
    if (pending_.size() >= kMaxPendingRequests) {
      error = "authority request capacity exhausted";
      return false;
    }
    request_id = "native-" + std::to_string(next_request_++);
    pending_.insert(request_id);
  }
  NSDictionary* frame = @{
    @"requestId" : [NSString stringWithUTF8String:request_id.c_str()],
    @"method" : method,
    @"payload" : payload == nil ? @{} : payload,
  };
  NSError* json_error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:frame options:0 error:&json_error];
  if (data == nil || json_error != nil) {
    error = "cannot serialize authority request";
    std::lock_guard<std::mutex> lock(state_mutex_);
    pending_.erase(request_id);
    return false;
  }
  std::string line(static_cast<const char*>(data.bytes), data.length);
  line.push_back('\n');
  if (!write_all(line, error)) {
    std::lock_guard<std::mutex> lock(state_mutex_);
    pending_.erase(request_id);
    return false;
  }

  std::unique_lock<std::mutex> lock(state_mutex_);
  const bool ready = state_changed_.wait_for(lock, std::chrono::seconds(10), [&] {
    return responses_.count(request_id) != 0 || closed_;
  });
  if (!ready) {
    pending_.erase(request_id);
    error = "authority request timed out";
    return false;
  }
  if (responses_.count(request_id) == 0) {
    pending_.erase(request_id);
    error = "authority channel closed before response";
    return false;
  }
  const std::string response_line = responses_[request_id];
  responses_.erase(request_id);
  lock.unlock();
  NSDictionary* response = nil;
  if (!parse_line(response_line, &response)) {
    error = "authority response is invalid JSON";
    return false;
  }
  if (result != nullptr) *result = response[@"result"];
  return true;
}

bool authority_request_once(int fd, NSString* method, NSDictionary* payload,
                            NSDictionary** result, std::string& error) {
  if (fd < 0) {
    error = "authority fd unavailable";
    return false;
  }
  if (result != nullptr) *result = nil;
  NSDictionary* frame = @{
    @"requestId" : @"native-bootstrap-1",
    @"method" : method,
    @"payload" : payload == nil ? @{} : payload,
  };
  NSError* json_error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:frame options:0 error:&json_error];
  if (data == nil || json_error != nil) {
    error = "cannot serialize authority request";
    return false;
  }
  std::string line(static_cast<const char*>(data.bytes), data.length);
  line.push_back('\n');
  if (!send_deadline(fd, line, error)) return false;

  std::string response;
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(kIoTimeoutMs);
  while (true) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                               deadline - std::chrono::steady_clock::now())
                               .count();
    if (remaining <= 0) {
      error = "authority bootstrap read timed out";
      return false;
    }
    if (!wait_fd(fd, POLLIN, static_cast<int>(remaining))) {
      error = "authority bootstrap read timed out";
      return false;
    }
    char byte = 0;
    const ssize_t count = recv(fd, &byte, 1, 0);
    if (count < 0) {
      if (errno == EINTR) continue;
      error = std::string("authority read failed: ") + std::strerror(errno);
      return false;
    }
    if (count == 0) {
      error = "authority closed before bootstrap response";
      return false;
    }
    if (byte == '\n') break;
    response.push_back(byte);
    if (response.size() > kMaxLineBytes) {
      error = "authority bootstrap response too large";
      return false;
    }
  }
  NSDictionary* parsed = nil;
  if (!parse_line(response, &parsed)) {
    error = "authority bootstrap response invalid";
    return false;
  }
  if (result != nullptr) *result = parsed[@"result"];
  return true;
}

}  // namespace zody::cua::round11
