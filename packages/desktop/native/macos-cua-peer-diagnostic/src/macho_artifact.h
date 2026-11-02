#pragma once

#include <string>
#include <vector>

struct MachOStaticFacts {
  bool ok = false;
  bool thin = false;
  std::string error;
  std::vector<std::string> architectures;
  std::string minimum_macos;
};

MachOStaticFacts inspect_macho(const std::string& path);
