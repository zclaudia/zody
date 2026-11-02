#include "macho_artifact.h"

#include <fcntl.h>
#include <mach-o/fat.h>
#include <mach-o/loader.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr size_t kMaxLoadCommands = 1024 * 1024;
constexpr uint32_t kMaxCommandCount = 4096;

std::string version_string(uint32_t value) {
  const uint32_t major = (value >> 16) & 0xffff;
  const uint32_t minor = (value >> 8) & 0xff;
  const uint32_t patch = value & 0xff;
  std::string result = std::to_string(major);
  if (minor != 0 || patch != 0) {
    result += "." + std::to_string(minor);
  }
  if (patch != 0) {
    result += "." + std::to_string(patch);
  }
  return result;
}

std::string architecture_name(cpu_type_t cputype, cpu_subtype_t cpusubtype) {
  if (cputype == CPU_TYPE_ARM64) {
    return (cpusubtype & 0x00ffffff) == CPU_SUBTYPE_ARM64E ? "arm64e" : "arm64";
  }
  if (cputype == CPU_TYPE_X86_64) {
    return "x86_64";
  }
  return "unknown";
}

bool read_exact_fd(int fd, void* buffer, size_t length) {
  auto* bytes = static_cast<uint8_t*>(buffer);
  size_t offset = 0;
  while (offset < length) {
    const ssize_t count = read(fd, bytes + offset, length - offset);
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      return false;
    }
    if (count == 0) {
      return false;
    }
    offset += static_cast<size_t>(count);
  }
  return true;
}

}  // namespace

MachOStaticFacts inspect_macho(const std::string& path) {
  MachOStaticFacts facts;
  const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    facts.error = std::string("cannot open executable: ") + std::strerror(errno);
    return facts;
  }
  struct stat info {};
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode)) {
    facts.error = "executable is not a regular file";
    close(fd);
    return facts;
  }

  uint32_t magic = 0;
  if (!read_exact_fd(fd, &magic, sizeof(magic))) {
    facts.error = "cannot read Mach-O magic";
    close(fd);
    return facts;
  }
  if (magic == FAT_MAGIC || magic == FAT_MAGIC_64) {
    facts.error = "fat Mach-O is not supported by this diagnostic";
    close(fd);
    return facts;
  }
  if (magic != MH_MAGIC_64) {
    facts.error = magic == MH_CIGAM_64 ? "byte-swapped Mach-O is not supported" : "not a thin 64-bit Mach-O";
    close(fd);
    return facts;
  }
  if (lseek(fd, 0, SEEK_SET) != 0) {
    facts.error = "cannot rewind executable";
    close(fd);
    return facts;
  }

  mach_header_64 header{};
  if (!read_exact_fd(fd, &header, sizeof(header))) {
    facts.error = "cannot read Mach-O header";
    close(fd);
    return facts;
  }
  if (header.ncmds > kMaxCommandCount || header.sizeofcmds > kMaxLoadCommands) {
    facts.error = "Mach-O load command bounds are invalid";
    close(fd);
    return facts;
  }
  std::vector<uint8_t> commands(header.sizeofcmds);
  if (!commands.empty() && !read_exact_fd(fd, commands.data(), commands.size())) {
    facts.error = "cannot read Mach-O load commands";
    close(fd);
    return facts;
  }
  close(fd);

  facts.architectures.push_back(architecture_name(header.cputype, header.cpusubtype));
  bool found_minimum = false;
  size_t offset = 0;
  for (uint32_t index = 0; index < header.ncmds; ++index) {
    if (offset + sizeof(load_command) > commands.size()) {
      facts.error = "Mach-O load command overruns its buffer";
      return facts;
    }
    const auto* command = reinterpret_cast<const load_command*>(commands.data() + offset);
    if (command->cmdsize < sizeof(load_command) || offset + command->cmdsize > commands.size()) {
      facts.error = "Mach-O load command size is invalid";
      return facts;
    }
    if (command->cmd == LC_BUILD_VERSION && command->cmdsize >= sizeof(build_version_command)) {
      const auto* build = reinterpret_cast<const build_version_command*>(command);
      if (build->platform == PLATFORM_MACOS) {
        facts.minimum_macos = version_string(build->minos);
        found_minimum = true;
      }
    } else if (command->cmd == LC_VERSION_MIN_MACOSX &&
               command->cmdsize >= sizeof(version_min_command)) {
      const auto* version = reinterpret_cast<const version_min_command*>(command);
      facts.minimum_macos = version_string(version->version);
      found_minimum = true;
    }
    offset += command->cmdsize;
  }
  if (!found_minimum) {
    facts.error = "Mach-O has no macOS minimum version load command";
    return facts;
  }
  facts.ok = true;
  facts.thin = true;
  return facts;
}
