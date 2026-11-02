#include "session_launcher.h"

#import <Foundation/Foundation.h>
#import <Security/Security.h>

#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <string>

#include "bundle_paths.h"
#include "cua_desktop_session_pins.h"
#include "session_control.h"
#include "session_node_process.h"

namespace zody::cua::desktop_session {
namespace {

struct EntryPin {
  const char* name;
  const char* sha256;
  size_t max_bytes;
};

struct ResourcePin {
  const char* name;
  const char* sha256;
  size_t max_bytes;
};

const ResourcePin kAuxiliaryResourcePins[] = {
    {"node-repl-server.mjs", CUA_DESKTOP_SESSION_RESOURCE_NODE_REPL_SERVER_SHA256,
     CUA_DESKTOP_SESSION_RESOURCE_NODE_REPL_SERVER_MAX_BYTES},
};

const EntryPin* entry_pin(const std::string& name) {
  static const EntryPin kPins[] = {
      {"host-entry.mjs", CUA_DESKTOP_SESSION_ENTRY_HOST_SHA256,
       CUA_DESKTOP_SESSION_ENTRY_HOST_MAX_BYTES},
      {"cli-entry.mjs", CUA_DESKTOP_SESSION_ENTRY_CLI_SHA256,
       CUA_DESKTOP_SESSION_ENTRY_CLI_MAX_BYTES},
      {"session-entry.mjs", CUA_DESKTOP_SESSION_ENTRY_SESSION_SHA256,
       CUA_DESKTOP_SESSION_ENTRY_SESSION_MAX_BYTES},
  };
  for (const EntryPin& pin : kPins) {
    if (name == pin.name) return &pin;
  }
  return nullptr;
}

std::string random_hex(size_t bytes) {
  unsigned char buffer[32];
  if (bytes > sizeof(buffer)) return "";
  if (SecRandomCopyBytes(kSecRandomDefault, bytes, buffer) != errSecSuccess) return "";
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.reserve(bytes * 2);
  for (size_t index = 0; index < bytes; ++index) {
    out.push_back(hex[(buffer[index] >> 4) & 0x0f]);
    out.push_back(hex[buffer[index] & 0x0f]);
  }
  return out;
}

bool create_private_dir(const std::string& path, std::string& error) {
  if (mkdir(path.c_str(), 0700) != 0) {
    error = std::string("cannot create private dir: ") + std::strerror(errno);
    return false;
  }
  if (chmod(path.c_str(), 0700) != 0) {
    error = std::string("cannot restrict private dir: ") + std::strerror(errno);
    (void)rmdir(path.c_str());
    return false;
  }
  return true;
}

bool create_run_dir(std::string& directory, std::string& error) {
  char pattern[] = "/tmp/io.github.zclaudia.zody.cua-desktop-session.XXXXXX";
  char* created = mkdtemp(pattern);
  if (created == nullptr) {
    error = std::string("cannot create private session dir: ") + std::strerror(errno);
    return false;
  }
  directory = created;
  if (chmod(directory.c_str(), 0700) != 0) {
    error = std::string("cannot restrict private session dir: ") + std::strerror(errno);
    (void)rmdir(directory.c_str());
    return false;
  }
  return true;
}

bool verify_auxiliary_resources(const zody::cua::round11::BundlePaths& paths,
                                std::string& error) {
  for (const ResourcePin& pin : kAuxiliaryResourcePins) {
    const std::string path = paths.resources + "/" + pin.name;
    zody::cua::round11::VerifiedResource resource;
    if (!zody::cua::round11::open_verified_resource(path, pin.sha256, resource, error)) {
      return false;
    }
    struct stat info {};
    if (fstat(resource.fd, &info) != 0 || info.st_size <= 0 ||
        static_cast<uint64_t>(info.st_size) > pin.max_bytes) {
      resource.close();
      error = path + ": resource size is outside the bound";
      return false;
    }
    resource.close();
  }
  return true;
}

void remove_direct_children(const std::string& directory) {
  DIR* dir = opendir(directory.c_str());
  if (dir == nullptr) return;
  while (dirent* entry = readdir(dir)) {
    if (std::strcmp(entry->d_name, ".") == 0 || std::strcmp(entry->d_name, "..") == 0) continue;
    const std::string child = directory + "/" + entry->d_name;
    // captureRoot 只允许 native 自己创建的直属 PNG；这里只删普通文件，不跟随目录/symlink。
    struct stat info {};
    if (lstat(child.c_str(), &info) == 0 && S_ISREG(info.st_mode)) (void)unlink(child.c_str());
  }
  closedir(dir);
}

void cleanup_run_dir(const std::string& directory, const std::string& capture_root) {
  if (!capture_root.empty()) {
    remove_direct_children(capture_root);
    (void)rmdir(capture_root.c_str());
  }
  if (!directory.empty()) (void)rmdir(directory.c_str());
}

std::string serialize_ready(const SessionLaunch& launch, pid_t node_pid) {
  NSDictionary* frame = @{
    @"schemaVersion" : @1,
    @"type" : @"session-ready",
    @"authorityEndpoint" : [NSString stringWithUTF8String:launch.authority_endpoint.c_str()],
    @"nodePid" : @(node_pid),
    @"entryName" : [NSString stringWithUTF8String:launch.entry_name.c_str()],
    @"entrySha256" : [NSString stringWithUTF8String:launch.entry_sha256.c_str()],
    @"producerIncarnation" :
        [NSString stringWithUTF8String:launch.producer_incarnation.c_str()],
    @"captureRoot" : [NSString stringWithUTF8String:launch.capture_root.c_str()],
  };
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:frame
                                                options:NSJSONWritingSortedKeys
                                                  error:&error];
  if (data == nil || error != nil) return "";
  return std::string(static_cast<const char*>(data.bytes), data.length);
}

zody::cua::round11::PinnedIdentity self_pinned_identity() {
  zody::cua::round11::PinnedIdentity pinned;
  pinned.bundle_id = CUA_DESKTOP_SESSION_SELF_IDENTIFIER;
  pinned.leaf_certificate_sha256 = CUA_DESKTOP_SESSION_SELF_LEAF_SHA256;
  pinned.designated_requirement = CUA_DESKTOP_SESSION_SELF_DESIGNATED_REQUIREMENT;
  pinned.configured = !pinned.bundle_id.empty() && !pinned.leaf_certificate_sha256.empty() &&
                      !pinned.designated_requirement.empty();
  return pinned;
}

zody::cua::round11::LoadedCodeExpectation node_loaded_code() {
  zody::cua::round11::LoadedCodeExpectation expected;
  expected.identifier = CUA_DESKTOP_SESSION_NODE_IDENTIFIER;
  expected.leaf_certificate_sha256 = CUA_DESKTOP_SESSION_NODE_LEAF_SHA256;
  expected.designated_requirement = CUA_DESKTOP_SESSION_NODE_DESIGNATED_REQUIREMENT;
  expected.cdhash_hex = CUA_DESKTOP_SESSION_NODE_CDHASH;
  expected.require_empty_entitlements = true;
  return expected;
}

}  // namespace

bool launch_trusted_session(const LaunchSessionOptions& options, SessionLaunch& launch,
                            std::string& error) {
  launch = SessionLaunch();
  const EntryPin* pin = entry_pin(options.entry_name);
  if (pin == nullptr || pin->sha256[0] == '\0') {
    error = "entry-name-not-allowed-or-unpinned";
    return false;
  }

  zody::cua::round11::SelfPreflight self =
      zody::cua::round11::evaluate_self_preflight(self_pinned_identity());
  if (!self.ok) {
    error = self.reason;
    return false;
  }

  zody::cua::round11::BundlePaths paths;
  if (!zody::cua::round11::resolve_bundle_paths(paths, error)) return false;
  if (!verify_auxiliary_resources(paths, error)) return false;
  const std::string entry_path = paths.resources + "/" + options.entry_name;

  zody::cua::round11::VerifiedResource node;
  if (!zody::cua::round11::open_verified_resource(paths.node,
                                                 CUA_DESKTOP_SESSION_NODE_SHA256, node, error)) {
    return false;
  }
  std::string sealed_js;
  if (!zody::cua::round11::read_verified_snapshot(entry_path, pin->sha256, pin->max_bytes,
                                                  sealed_js, error)) {
    node.close();
    return false;
  }

  launch.entry_name = options.entry_name;
  launch.entry_sha256 = pin->sha256;
  launch.producer_incarnation = random_hex(24);
  if (launch.producer_incarnation.empty()) {
    node.close();
    error = "producer-incarnation-unavailable";
    return false;
  }

  if (!create_run_dir(launch.run_dir, error)) {
    node.close();
    return false;
  }
  launch.capture_root = launch.run_dir + "/captures";
  if (!create_private_dir(launch.capture_root, error)) {
    cleanup_run_dir(launch.run_dir, launch.capture_root);
    node.close();
    return false;
  }
  launch.authority_endpoint = launch.run_dir + "/authority.sock";
  if (!create_private_listener(launch.authority_endpoint, launch.authority_listener,
                               launch.authority_ownership, error)) {
    cleanup_run_dir(launch.run_dir, launch.capture_root);
    node.close();
    return false;
  }

  SessionNodeFds fds;
  fds.host_bridge_fd = options.host_bridge_fd;
  fds.cli_input_fd = options.cli_input_fd;
  fds.cli_output_fd = options.cli_output_fd;
  if (!launch_session_node(paths.node, node.fd, sealed_js, node_loaded_code(), fds, launch.node,
                           error)) {
    node.close();
    shutdown_trusted_session(launch);
    return false;
  }
  node.close();

  SessionControl control(launch.node.control_fd);
  const std::string ready = serialize_ready(launch, launch.node.pid);
  if (ready.empty()) {
    error = "session-ready-serialization-failed";
    shutdown_trusted_session(launch);
    return false;
  }
  NSData* data = [NSData dataWithBytes:ready.data() length:ready.size()];
  NSError* json_error = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&json_error];
  if (parsed == nil || json_error != nil || ![parsed isKindOfClass:[NSDictionary class]] ||
      !control.write_frame(static_cast<NSDictionary*>(parsed), error)) {
    if (error.empty()) error = "session-ready-write-failed";
    shutdown_trusted_session(launch);
    return false;
  }
  return true;
}

void shutdown_trusted_session(SessionLaunch& launch) {
  launch.node.close_control();
  if (launch.authority_listener >= 0) {
    close_owned_socket(launch.authority_listener, launch.authority_endpoint,
                       launch.authority_ownership);
    launch.authority_listener = -1;
  }
  launch.node.stop();
  cleanup_run_dir(launch.run_dir, launch.capture_root);
  launch.run_dir.clear();
  launch.capture_root.clear();
}

}  // namespace zody::cua::desktop_session
