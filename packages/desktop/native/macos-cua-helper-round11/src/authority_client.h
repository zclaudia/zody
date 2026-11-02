#pragma once

#import <Foundation/Foundation.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>

namespace zody::cua::round11 {

// FD3 NDJSON 唯一 owner。后台读线程持续处理 response / revocation / EOF，
// request 只负责发送并按 requestId 等待；撤销不会被截图等待阻塞。
class AuthorityClient {
 public:
  explicit AuthorityClient(int fd) : fd_(fd) {}
  ~AuthorityClient();
  AuthorityClient(const AuthorityClient&) = delete;
  AuthorityClient& operator=(const AuthorityClient&) = delete;

  bool start(std::function<void(const std::string&)> on_revocation,
             std::function<void(const std::string&)> on_closed, std::string& error);
  bool request(NSString* method, NSDictionary* payload, NSDictionary** result,
               std::string& error);
  // 只触发 peer EOF：shutdown 让既有 reader 走 on_closed/cancel，不 join/close。
  void interrupt();
  // 幂等：第一个调用者 shutdown/join/close，其余调用者等待 closed_ 后返回。
  void close();

 private:
  bool write_all(const std::string& bytes, std::string& error);
  void reader_loop();

  std::atomic<int> fd_;
  uint64_t next_request_ = 1;
  std::mutex write_mutex_;
  std::mutex state_mutex_;
  std::condition_variable state_changed_;
  std::map<std::string, std::string> responses_;
  std::set<std::string> pending_;
  std::function<void(const std::string&)> on_revocation_;
  std::function<void(const std::string&)> on_closed_;
  std::thread reader_;
  bool close_started_ = false;
  bool closed_ = false;
};

// bootstrap 专用一次性请求：不启动 reader 线程，成功后可把同一 fd 原样转交
// Helper。只允许在转交前使用；之后 fd 的唯一 owner 是 Helper 的 AuthorityClient。
bool authority_request_once(int fd, NSString* method, NSDictionary* payload,
                            NSDictionary** result, std::string& error);

}  // namespace zody::cua::round11
