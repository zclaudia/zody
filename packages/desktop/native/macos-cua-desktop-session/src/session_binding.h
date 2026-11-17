#pragma once

#import <Foundation/Foundation.h>

#include <cstdint>
#include <string>

namespace zody::cua::desktop_session {

struct SessionTarget {
  uint32_t window_id = 0;
  int32_t pid = 0;
  int32_t layer = 0;
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
  std::string owner_name;
  std::string window_name;

  bool identified() const { return window_id != 0 && pid > 0; }
  bool measured() const;
  bool same_identity(const SessionTarget& other) const;
  bool same_bounds(const SessionTarget& other) const;
};

struct SessionBinding {
  std::string trace_id;
  std::string producer_incarnation;
  std::string run_id;
  std::string turn_id;
  std::string submission_lineage_id;
  std::string app_incarnation;
  std::string host_instance_id;
  std::string runtime_instance_id;
  std::string session_id;
  std::string workspace_key;
  std::string workspace_identity;
  std::string remote_session_id;
  int64_t authorization_revision = 0;
  SessionTarget target;

  bool valid() const;
  bool same_scope(const SessionBinding& other) const;
  std::string display_text() const;
};

// 只接受有界、非空的完整身份；任何字段缺失或 revision 非法都 fail-closed。
bool parse_session_binding(NSDictionary* value, SessionBinding& binding, std::string& error);

// go 帧使用 JSON 传输；重新解析而不是复用 supervisor 的字符串拼接。
bool parse_session_binding_json(const std::string& json, SessionBinding& binding,
                                std::string& error);

std::string session_binding_json(const SessionBinding& binding);
NSDictionary* session_ref_dictionary(const SessionBinding& binding);
NSDictionary* session_association_dictionary(const SessionBinding& binding);
NSDictionary* session_target_dictionary(const SessionBinding& binding);

}  // namespace zody::cua::desktop_session
