#include "session_cell_relay.h"

#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>

namespace zody::cua::desktop_session {
namespace {

constexpr size_t kRelayChunkBytes = 64 * 1024;
constexpr size_t kRelayBufferMaxBytes = 256 * 1024;
constexpr int kRelayPollMs = 250;

int poll_timeout_ms(const std::chrono::steady_clock::time_point& deadline) {
  const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                             deadline - std::chrono::steady_clock::now())
                             .count();
  if (remaining <= 0) return 0;
  return static_cast<int>(std::min<int64_t>(remaining, kRelayPollMs));
}

}  // namespace

CellRelayOutcome relay_cell_streams(int client_fd, int request_write, int response_read,
                                    const CellRelayLimits& limits,
                                    const std::atomic<bool>& stop, std::string& error) {
  error.clear();
  if (client_fd < 0 || request_write < 0 || response_read < 0) {
    error = "cell relay descriptors invalid";
    return CellRelayOutcome::Aborted;
  }
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(limits.timeout_ms);

  std::string to_cell;
  size_t to_cell_offset = 0;
  std::string to_cli;
  size_t to_cli_offset = 0;
  size_t request_bytes = 0;
  size_t response_bytes = 0;
  // 中文原因：fd3 只允许一条 CellRequest，fd4 只允许一条 CellResponse；必须按
  // 实际 frame 边界执行上限，而不是只靠 256KiB 缓冲高水位或 open 帧自报的 max。
  // cell 若在响应行后继续写入，Helper 不能把它当成长响应转发，否则 TS 侧会把
  // 伪造的 cell-exit 帧当成 Helper 的真实 reap 结果。
  size_t request_line_bytes = 0;
  size_t response_line_bytes = 0;
  bool request_line_complete = false;
  bool response_line_complete = false;
  bool cell_eof = false;
  bool request_closed = false;

  while (true) {
    if (stop.load(std::memory_order_acquire)) {
      error = "cell transport stopping";
      return CellRelayOutcome::Stopped;
    }
    if (cell_eof && to_cell_offset >= to_cell.size() && to_cli_offset >= to_cli.size()) {
      return CellRelayOutcome::Completed;
    }
    if (std::chrono::steady_clock::now() >= deadline) {
      error = "cell relay deadline exceeded";
      return CellRelayOutcome::TimedOut;
    }

    struct pollfd entries[4];
    int client_read = -1;
    int request_out = -1;
    int response_in = -1;
    int client_write = -1;
    int count = 0;
    if (to_cell.size() - to_cell_offset < kRelayBufferMaxBytes) {
      client_read = count;
      entries[count++] = {client_fd, POLLIN, 0};
    }
    if (!request_closed && to_cell_offset < to_cell.size()) {
      request_out = count;
      entries[count++] = {request_write, POLLOUT, 0};
    }
    if (!cell_eof && to_cli.size() - to_cli_offset < kRelayBufferMaxBytes) {
      response_in = count;
      entries[count++] = {response_read, POLLIN, 0};
    }
    if (to_cli_offset < to_cli.size()) {
      client_write = count;
      entries[count++] = {client_fd, POLLOUT, 0};
    }
    if (count == 0) {
      // cell 已 EOF 但 request 端仍有残留时，没有更多可推进的事件就结束；
      // 不能空转等待后代继续持有 fd4。
      if (cell_eof) return CellRelayOutcome::Completed;
      usleep(static_cast<useconds_t>(kRelayPollMs * 1000));
      continue;
    }

    const int result = poll(entries, static_cast<nfds_t>(count), poll_timeout_ms(deadline));
    if (result < 0) {
      if (errno == EINTR) continue;
      error = std::string("cell relay poll failed: ") + std::strerror(errno);
      return CellRelayOutcome::Aborted;
    }
    if (result == 0) continue;

    char chunk[kRelayChunkBytes];
    if (client_read >= 0 && (entries[client_read].revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
      const ssize_t received = recv(client_fd, chunk, sizeof(chunk), 0);
      if (received == 0) {
        // 中文原因：CLI 进程消失或主动断开时必须立即 abort，不能只关闭 request
        // 写端后继续轮询；后代可能持有 fd4 让旧实现永久不退出。
        error = "cell client eof";
        return CellRelayOutcome::ClientEof;
      }
      if (received < 0) {
        if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) {
          error = std::string("cell client read failed: ") + std::strerror(errno);
          return CellRelayOutcome::ClientEof;
        }
      } else {
        request_bytes += static_cast<size_t>(received);
        if (request_bytes > limits.request_max_bytes) {
          error = "cell request bound exceeded";
          return CellRelayOutcome::RequestBoundExceeded;
        }
        for (ssize_t index = 0; index < received; ++index) {
          if (request_line_complete) {
            error = "cell request contains more than one frame";
            return CellRelayOutcome::RequestBoundExceeded;
          }
          ++request_line_bytes;
          if (request_line_bytes > limits.request_max_bytes) {
            error = "cell request frame bound exceeded";
            return CellRelayOutcome::RequestBoundExceeded;
          }
          if (chunk[index] == '\n') request_line_complete = true;
        }
        to_cell.append(chunk, static_cast<size_t>(received));
      }
    }

    if (request_out >= 0 &&
        (entries[request_out].revents & (POLLOUT | POLLHUP | POLLERR)) != 0) {
      const ssize_t written = write(request_write, to_cell.data() + to_cell_offset,
                                    to_cell.size() - to_cell_offset);
      if (written > 0) {
        to_cell_offset += static_cast<size_t>(written);
        if (to_cell_offset >= to_cell.size()) {
          to_cell.clear();
          to_cell_offset = 0;
        }
      } else if (written < 0 &&
                 (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) {
        // 短暂不可写，下一轮继续。
      } else {
        if (cell_eof) {
          request_closed = true;
          to_cell.clear();
          to_cell_offset = 0;
        } else {
          error = "cell request pipe closed";
          return CellRelayOutcome::Aborted;
        }
      }
    }

    if (response_in >= 0 &&
        (entries[response_in].revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
      const ssize_t received = read(response_read, chunk, sizeof(chunk));
      if (received == 0) {
        cell_eof = true;
      } else if (received < 0) {
        if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) {
          error = std::string("cell response read failed: ") + std::strerror(errno);
          return CellRelayOutcome::Aborted;
        }
      } else {
        response_bytes += static_cast<size_t>(received);
        if (response_bytes > limits.response_max_bytes) {
          error = "cell response bound exceeded";
          return CellRelayOutcome::ResponseBoundExceeded;
        }
        for (ssize_t index = 0; index < received; ++index) {
          if (response_line_complete) {
            error = "cell response contains more than one frame";
            return CellRelayOutcome::ResponseBoundExceeded;
          }
          ++response_line_bytes;
          if (response_line_bytes > limits.response_max_bytes) {
            error = "cell response frame bound exceeded";
            return CellRelayOutcome::ResponseBoundExceeded;
          }
          if (chunk[index] == '\n') response_line_complete = true;
        }
        to_cli.append(chunk, static_cast<size_t>(received));
      }
    }

    if (client_write >= 0 &&
        (entries[client_write].revents & (POLLOUT | POLLHUP | POLLERR)) != 0) {
      const ssize_t written =
          send(client_fd, to_cli.data() + to_cli_offset, to_cli.size() - to_cli_offset, 0);
      if (written > 0) {
        to_cli_offset += static_cast<size_t>(written);
        if (to_cli_offset >= to_cli.size()) {
          to_cli.clear();
          to_cli_offset = 0;
        }
      } else if (written < 0 &&
                 (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) {
        // 短暂不可写，下一轮继续。
      } else {
        error = "cell client write closed";
        return CellRelayOutcome::ClientEof;
      }
    }
  }
}

}  // namespace zody::cua::desktop_session
