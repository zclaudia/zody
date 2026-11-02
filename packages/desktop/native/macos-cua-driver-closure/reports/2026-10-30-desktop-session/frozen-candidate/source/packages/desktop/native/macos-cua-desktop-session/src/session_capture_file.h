#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace zody::cua::desktop_session {

constexpr size_t kMaxCaptureBytes = 32 * 1024 * 1024;

// captureRoot 必须是本进程私有 0700 目录；path 只能是其直属、同 uid、0600、
// O_NOFOLLOW 的普通文件。SHA/IHDR 都必须与 helper 实际结果一致。
bool verify_capture_file(const std::string& capture_root, const std::string& path,
                         const std::string& expected_sha256, uint32_t expected_width,
                         uint32_t expected_height, size_t& size, std::string& error);

}  // namespace zody::cua::desktop_session
