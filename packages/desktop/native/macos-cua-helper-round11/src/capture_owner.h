#pragma once

#import <Foundation/Foundation.h>

#include <string>

#include "authority_client.h"
#include "machine_lease.h"

namespace zody::cua::round11 {

struct CaptureRequestContext {
  NSDictionary* ref = nil;
  NSString* trace_id = nil;
  NSString* producer_incarnation = nil;
  NSString* run_id = nil;
  NSString* turn_id = nil;
  NSString* output_path = nil;
  uint32_t window_id = 0;
  int32_t pid = 0;
  int32_t layer = 0;
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
};

struct CaptureOutcome {
  bool ok = false;
  std::string reason;
  std::string png_sha256;
  uint32_t width = 0;
  uint32_t height = 0;
  bool revoked = false;
  // 只有 native callback 明确归还资源后才为 true；否则不得释放 lease。
  bool resources_released = true;
};

// 实际 CABI 执行 owner：同一 machine lock、同一 authority ref，三个 checkpoint
// 重核；只有真实 PNG + 撤销事实 + callback release 才成功。
CaptureOutcome capture_once(AuthorityClient& authority, MachineLease& lease,
                            const CaptureRequestContext& context);

}  // namespace zody::cua::round11
