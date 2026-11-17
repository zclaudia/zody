#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#include <libproc.h>
#include <cassert>

static NSDictionary *OriginMetadata(BOOL present, OSType eventClass, OSType eventId, NSAppleEventDescriptor *sender, NSAppleEventDescriptor *reason) {
  BOOL validSender = sender.descriptorType == typeSInt32 && sender.int32Value > 0;
  BOOL validReason = reason.descriptorType == typeEnumerated;
  char path[PROC_PIDPATHINFO_MAXSIZE] = {};
  if (validSender) proc_pidpath(sender.int32Value, path, sizeof(path));
  // 中文原因：只读取退出信封的发送者身份；严禁打印 descriptor.description 或事件正文。
  return @{ @"present": @(present), @"eventClass": @(eventClass),
    @"eventId": @(eventId),
    @"isQuitApplication": @(present && eventClass == kCoreEventClass && eventId == kAEQuitApplication),
    @"senderPid": validSender ? @(sender.int32Value) : (id)NSNull.null,
    @"senderType": @(sender ? sender.descriptorType : 0),
    @"senderExecutable": path[0] ? [NSString stringWithUTF8String:path] : (id)NSNull.null,
    @"quitReason": validReason ? @(reason.enumCodeValue) : (id)NSNull.null };
}
static NSDictionary *QuitOrigin(NSAppleEventDescriptor *event) {
  return OriginMetadata(event != nil, event ? event.eventClass : 0, event ? event.eventID : 0,
    [event attributeDescriptorForKeyword:keySenderPIDAttr], [event paramDescriptorForKeyword:kAEQuitReason]);
}

#ifdef ZODY_QUIT_ORIGIN_TEST
int main() { @autoreleasepool {
  NSDictionary *absent = QuitOrigin(nil);
  assert(![absent[@"present"] boolValue] && absent[@"senderPid"] == NSNull.null);
  NSAppleEventDescriptor *event = [NSAppleEventDescriptor appleEventWithEventClass:kCoreEventClass eventID:kAEQuitApplication targetDescriptor:nil returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID];
  assert([QuitOrigin(event)[@"isQuitApplication"] boolValue]);
  assert(QuitOrigin(event)[@"senderPid"] == NSNull.null);
  // sender PID 为系统只读属性；单测直接验证共同的元数据提取，不伪造真实事件发送者。
  NSDictionary *valid = OriginMetadata(YES, kCoreEventClass, kAEQuitApplication,
    [NSAppleEventDescriptor descriptorWithInt32:getpid()], [NSAppleEventDescriptor descriptorWithEnumCode:kAEQuitAll]);
  assert([valid[@"senderPid"] intValue] == getpid());
  assert([valid[@"quitReason"] unsignedIntValue] == kAEQuitAll);
  assert(valid[@"senderExecutable"] != NSNull.null);
  NSDictionary *invalid = OriginMetadata(YES, kCoreEventClass, kAEQuitApplication,
    [NSAppleEventDescriptor descriptorWithString:@"1234"], [NSAppleEventDescriptor descriptorWithString:@"quit"]);
  assert(invalid[@"senderPid"] == NSNull.null && invalid[@"quitReason"] == NSNull.null);
  NSAppleEventDescriptor *other = [NSAppleEventDescriptor appleEventWithEventClass:kCoreEventClass eventID:kAEOpenDocuments targetDescriptor:nil returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID];
  assert(![QuitOrigin(other)[@"isQuitApplication"] boolValue]);
  puts("quit-origin metadata tests passed (no AppleEvent sent)");
} return 0; }
#else
#include <node_api.h>
#include "quit_signal_observer.h"
static napi_value InstallSignals(napi_env env, napi_callback_info info) {
  size_t count = 1, length = 0; napi_value argument; char path[4096] = {};
  if (napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr) != napi_ok || count != 1 ||
      napi_get_value_string_utf8(env, argument, path, sizeof(path), &length) != napi_ok ||
      length == 0 || length >= sizeof(path) - 1 || strlen(path) != length ||
      !quit_diagnostic::Install(path, {SIGHUP, SIGINT, SIGTERM})) {
    napi_throw_error(env, nullptr, "Signal observer setup refused"); return nullptr;
  }
  NSMutableArray *signals = [NSMutableArray array];
  for (int signal : quit_diagnostic::observed) [signals addObject:@(signal)];
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{ @"installedSignals": signals, @"forwardExisting": @YES } options:0 error:nil];
  napi_value value; napi_create_string_utf8(env, static_cast<const char *>(data.bytes), data.length, &value); return value;
}
static napi_value Read(napi_env env, napi_callback_info info) {
  (void)info;
  @autoreleasepool {
    NSMutableDictionary *metadata = [QuitOrigin(NSAppleEventManager.sharedAppleEventManager.currentAppleEvent) mutableCopy];
    metadata[@"nativeStack"] = NSThread.callStackSymbols;
    int signal = quit_diagnostic::lastSignal.load(std::memory_order_acquire);
    int sender = quit_diagnostic::lastSender.load(std::memory_order_relaxed);
    char signalPath[PROC_PIDPATHINFO_MAXSIZE] = {};
    if (signal && sender > 0) proc_pidpath(sender, signalPath, sizeof(signalPath));
    metadata[@"signalOrigin"] = @{ @"signal": @(signal), @"senderPid": @(sender),
      @"senderExecutable": signalPath[0] ? [NSString stringWithUTF8String:signalPath] : (id)NSNull.null };
    NSData *data = [NSJSONSerialization dataWithJSONObject:metadata options:0 error:nil];
    napi_value value;
    if (!data || napi_create_string_utf8(env, static_cast<const char *>(data.bytes), data.length, &value) != napi_ok) {
      napi_throw_error(env, nullptr, "Quit origin metadata unavailable"); return nullptr;
    }
    return value;
  }
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"readQuitOrigin", nullptr, Read, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"installSignalObserver", nullptr, InstallSignals, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  if (napi_define_properties(env, exports, 2, properties) != napi_ok) return nullptr;
  return exports;
}
NAPI_MODULE(quit_origin, Init)
#endif
