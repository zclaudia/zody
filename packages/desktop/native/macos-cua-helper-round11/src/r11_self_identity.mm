#import <CommonCrypto/CommonDigest.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>

#include "r11_self_identity.h"

#include <cstring>
#include <string>

namespace zody::cua::round11 {
namespace {

constexpr uint32_t kCsRuntime = 0x00010000U;
constexpr uint32_t kSecCodeSignatureAdhoc = 0x00000002U;

std::string cf_string(CFStringRef value) {
  if (value == nullptr) return "";
  const CFIndex length = CFStringGetLength(value);
  const CFIndex maximum =
      CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  std::string result(static_cast<size_t>(maximum), '\0');
  if (!CFStringGetCString(value, result.data(), maximum, kCFStringEncodingUTF8)) {
    return "";
  }
  result.resize(std::strlen(result.c_str()));
  return result;
}

std::string hex_encode(const UInt8* bytes, size_t length) {
  static const char* hex = "0123456789abcdef";
  std::string result;
  result.reserve(length * 2);
  for (size_t index = 0; index < length; ++index) {
    result.push_back(hex[(bytes[index] >> 4) & 0x0f]);
    result.push_back(hex[bytes[index] & 0x0f]);
  }
  return result;
}

std::string sha256_hex(const UInt8* bytes, CFIndex length) {
  uint8_t digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes, static_cast<CC_LONG>(length), digest);
  return hex_encode(digest, sizeof(digest));
}

void release_if(CFTypeRef value) {
  if (value != nullptr) CFRelease(value);
}

bool forbidden_entitlement_json(const std::string& json) {
  return json.find("disable-library-validation") != std::string::npos ||
         json.find("allow-dyld-environment-variables") != std::string::npos ||
         json.find("get-task-allow") != std::string::npos;
}

std::string canonical_json(CFTypeRef value) {
  if (value == nullptr) return "";
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:(__bridge id)value
                                                 options:NSJSONWritingSortedKeys
                                                   error:&error];
  if (data == nil || error != nil) return "";
  NSString* text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  return text == nil ? "" : std::string([text UTF8String]);
}

bool is_forbidden_entitlement(NSString* key) {
  static NSSet<NSString*>* forbidden = [NSSet setWithObjects:
      @"com.apple.security.cs.disable-library-validation",
      @"com.apple.security.cs.allow-dyld-environment-variables",
      @"com.apple.security.get-task-allow",
      nil];
  return [forbidden containsObject:key];
}

}  // namespace

LoadedCodeResult verify_loaded_code_for_pid(pid_t pid, const LoadedCodeExpectation& expected) {
  LoadedCodeResult result;
  if (pid <= 0) {
    result.reason = "invalid-pid";
    return result;
  }
  int pid_value = static_cast<int>(pid);
  CFNumberRef pid_number = CFNumberCreate(nullptr, kCFNumberIntType, &pid_value);
  if (pid_number == nullptr) {
    result.reason = "pid-attribute-allocation-failed";
    return result;
  }
  const void* keys[] = {kSecGuestAttributePid};
  const void* values[] = {pid_number};
  CFDictionaryRef attributes = CFDictionaryCreate(
      nullptr, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFRelease(pid_number);
  if (attributes == nullptr) {
    result.reason = "guest-attribute-allocation-failed";
    return result;
  }
  SecCodeRef code = nullptr;
  OSStatus status = SecCodeCopyGuestWithAttributes(
      nullptr, attributes, kSecCSDefaultFlags, &code);
  CFRelease(attributes);
  result.guest_created = status == errSecSuccess && code != nullptr;
  if (!result.guest_created) {
    result.reason = "loaded-code-unavailable";
    release_if(code);
    return result;
  }

  SecRequirementRef requirement = nullptr;
  CFStringRef requirement_text = CFStringCreateWithCString(
      nullptr, expected.designated_requirement.c_str(), kCFStringEncodingUTF8);
  if (requirement_text != nullptr) {
    (void)SecRequirementCreateWithString(
        requirement_text, kSecCSDefaultFlags, &requirement);
    CFRelease(requirement_text);
  }
  status = SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement);
  result.code_valid = status == errSecSuccess;
  result.requirement_matched = requirement != nullptr && result.code_valid;

  CFDictionaryRef information = nullptr;
  status = SecCodeCopySigningInformation(
      code, kSecCSSigningInformation | kSecCSRequirementInformation, &information);
  if (status == errSecSuccess && information != nullptr) {
    CFTypeRef flags = CFDictionaryGetValue(information, kSecCodeInfoFlags);
    if (flags != nullptr && CFGetTypeID(flags) == CFNumberGetTypeID()) {
      uint32_t value = 0;
      if (CFNumberGetValue(static_cast<CFNumberRef>(flags), kCFNumberSInt32Type, &value)) {
        result.flags = value;
        result.adhoc = (value & kSecCodeSignatureAdhoc) != 0;
        result.hardened_runtime = (value & kCsRuntime) != 0;
      }
    }
    CFTypeRef identifier = CFDictionaryGetValue(information, kSecCodeInfoIdentifier);
    if (identifier != nullptr && CFGetTypeID(identifier) == CFStringGetTypeID()) {
      result.identifier = cf_string(static_cast<CFStringRef>(identifier));
    }
    CFTypeRef certificates = CFDictionaryGetValue(information, kSecCodeInfoCertificates);
    if (certificates != nullptr && CFGetTypeID(certificates) == CFArrayGetTypeID()) {
      CFArrayRef array = static_cast<CFArrayRef>(certificates);
      if (CFArrayGetCount(array) > 0) {
        result.certificate_present = true;
        SecCertificateRef leaf = reinterpret_cast<SecCertificateRef>(
            const_cast<void*>(CFArrayGetValueAtIndex(array, 0)));
        CFDataRef der = SecCertificateCopyData(leaf);
        if (der != nullptr) {
          result.leaf_sha256 = sha256_hex(CFDataGetBytePtr(der), CFDataGetLength(der));
          release_if(der);
        }
      }
    }
    CFTypeRef unique = CFDictionaryGetValue(information, kSecCodeInfoUnique);
    if (unique != nullptr && CFGetTypeID(unique) == CFDataGetTypeID()) {
      CFDataRef digest = static_cast<CFDataRef>(unique);
      result.cdhash_hex = hex_encode(
          CFDataGetBytePtr(digest), static_cast<size_t>(CFDataGetLength(digest)));
    }
    CFTypeRef designated = CFDictionaryGetValue(information, kSecCodeInfoDesignatedRequirement);
    if (designated != nullptr && CFGetTypeID(designated) == SecRequirementGetTypeID()) {
      CFStringRef text = nullptr;
      if (SecRequirementCopyString(
              reinterpret_cast<SecRequirementRef>(const_cast<void*>(designated)),
              kSecCSDefaultFlags, &text) == errSecSuccess &&
          text != nullptr) {
        result.designated_requirement = cf_string(text);
        release_if(text);
      }
    }
    CFTypeRef entitlements = CFDictionaryGetValue(information, kSecCodeInfoEntitlementsDict);
    if (entitlements != nullptr && CFGetTypeID(entitlements) == CFDictionaryGetTypeID()) {
      const std::string json = canonical_json(entitlements);
      result.entitlements_empty = json == "{}";
      if (forbidden_entitlement_json(json)) {
        result.reason = "loaded-code-forbidden-entitlement";
      }
    }
    release_if(information);
  }
  release_if(requirement);
  release_if(code);

  result.identifier_matched = !expected.identifier.empty() &&
                              result.identifier == expected.identifier;
  result.leaf_matched = !expected.leaf_certificate_sha256.empty() &&
                        result.leaf_sha256 == expected.leaf_certificate_sha256;
  result.cdhash_matched = !expected.cdhash_hex.empty() &&
                          result.cdhash_hex == expected.cdhash_hex;
  if (result.reason.empty()) {
    if (!result.code_valid) result.reason = "loaded-code-invalid";
    else if (result.adhoc) result.reason = "loaded-code-ad-hoc";
    else if (!result.certificate_present) result.reason = "loaded-code-missing-certificate";
    else if (!result.hardened_runtime) result.reason = "loaded-code-hardened-runtime-missing";
    else if (expected.require_empty_entitlements && !result.entitlements_empty)
      result.reason = "loaded-code-unexpected-entitlements";
    else if (!result.identifier_matched) result.reason = "loaded-code-identifier-mismatch";
    else if (!result.leaf_matched) result.reason = "loaded-code-leaf-mismatch";
    else if (!result.cdhash_matched) result.reason = "loaded-code-cdhash-mismatch";
    else if (!result.requirement_matched) result.reason = "loaded-code-requirement-mismatch";
    else {
      result.ok = true;
      result.reason = "accepted";
    }
  }
  return result;
}

SelfPreflight evaluate_self_preflight(const PinnedIdentity& pinned) {
  SelfPreflight preflight;
  preflight.pin_configured = pinned.configured;

  SecCodeRef code = nullptr;
  OSStatus status = SecCodeCopySelf(kSecCSDefaultFlags, &code);
  preflight.code_created = status == errSecSuccess && code != nullptr;
  if (!preflight.code_created) {
    preflight.reason = "self-code-unavailable";
    release_if(code);
    return preflight;
  }

  SecStaticCodeRef static_code = nullptr;
  status = SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &static_code);
  preflight.static_code_created = status == errSecSuccess && static_code != nullptr;
  if (preflight.static_code_created) {
    // 默认规则同时校验 CodeResources 中 sealed 的 bundle 资源。
    status = SecStaticCodeCheckValidity(static_code, kSecCSDefaultFlags, nullptr);
    preflight.resource_seal_valid = status == errSecSuccess;
  }

  status = SecCodeCheckValidity(code, kSecCSDefaultFlags, nullptr);
  preflight.code_valid = status == errSecSuccess;

  CFDictionaryRef information = nullptr;
  status = SecCodeCopySigningInformation(
      code, kSecCSSigningInformation | kSecCSRequirementInformation, &information);
  preflight.signing_information_available = status == errSecSuccess && information != nullptr;
#ifdef __clang__
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#endif
  if (preflight.signing_information_available) {
    CFTypeRef flags = CFDictionaryGetValue(information, kSecCodeInfoFlags);
    if (flags != nullptr && CFGetTypeID(flags) == CFNumberGetTypeID()) {
      uint32_t value = 0;
      if (CFNumberGetValue(static_cast<CFNumberRef>(flags), kCFNumberSInt32Type, &value)) {
        preflight.adhoc = (value & kSecCodeSignatureAdhoc) != 0;
        preflight.hardened_runtime = (value & kCsRuntime) != 0;
      }
    }
    CFTypeRef identifier = CFDictionaryGetValue(information, kSecCodeInfoIdentifier);
    if (identifier != nullptr && CFGetTypeID(identifier) == CFStringGetTypeID()) {
      preflight.identifier = cf_string(static_cast<CFStringRef>(identifier));
    }
    CFTypeRef certificates = CFDictionaryGetValue(information, kSecCodeInfoCertificates);
    if (certificates != nullptr && CFGetTypeID(certificates) == CFArrayGetTypeID()) {
      CFArrayRef array = static_cast<CFArrayRef>(certificates);
      if (CFArrayGetCount(array) > 0) {
        preflight.certificate_present = true;
        SecCertificateRef leaf = reinterpret_cast<SecCertificateRef>(
            const_cast<void*>(CFArrayGetValueAtIndex(array, 0)));
        CFDataRef der = SecCertificateCopyData(leaf);
        if (der != nullptr) {
          preflight.leaf_sha256 =
              sha256_hex(CFDataGetBytePtr(der), CFDataGetLength(der));
          release_if(der);
        }
      }
    }
    CFTypeRef entitlements = CFDictionaryGetValue(information, kSecCodeInfoEntitlementsDict);
    if (entitlements != nullptr && CFGetTypeID(entitlements) == CFDictionaryGetTypeID()) {
      NSDictionary* dictionary = (__bridge NSDictionary*)entitlements;
      preflight.entitlements_present = true;
      preflight.entitlements_empty = dictionary.count == 0;
      preflight.entitlements_json = canonical_json(entitlements);
      for (NSString* key in dictionary) {
        if (is_forbidden_entitlement(key)) {
          preflight.forbidden_entitlements_present = true;
          break;
        }
      }
    } else {
      // 本 native 预期空 entitlements；缺失等同于空集。
      preflight.entitlements_empty = true;
    }
    CFTypeRef requirement = CFDictionaryGetValue(information, kSecCodeInfoDesignatedRequirement);
    if (requirement != nullptr && CFGetTypeID(requirement) == SecRequirementGetTypeID()) {
      CFStringRef text = nullptr;
      if (SecRequirementCopyString(
              reinterpret_cast<SecRequirementRef>(const_cast<void*>(requirement)),
              kSecCSDefaultFlags, &text) == errSecSuccess &&
          text != nullptr) {
        preflight.designated_requirement = cf_string(text);
        release_if(text);
      }
    }
  }
#ifdef __clang__
#pragma clang diagnostic pop
#endif

  release_if(information);
  release_if(static_code);
  release_if(code);

  preflight.leaf_pin_matched =
      !pinned.leaf_certificate_sha256.empty() &&
      preflight.leaf_sha256 == pinned.leaf_certificate_sha256;
  preflight.designated_requirement_matched =
      !pinned.designated_requirement.empty() &&
      preflight.designated_requirement == pinned.designated_requirement;
  preflight.identifier_matched =
      !pinned.bundle_id.empty() && preflight.identifier == pinned.bundle_id;

  if (!pinned.configured) {
    preflight.reason = "signing-pin-missing";
    return preflight;
  }
  if (!preflight.code_created || !preflight.code_valid) {
    preflight.reason = "unsigned-or-invalid";
    return preflight;
  }
  if (preflight.adhoc) {
    preflight.reason = "ad-hoc-signature";
    return preflight;
  }
  if (!preflight.certificate_present) {
    preflight.reason = "missing-certificate";
    return preflight;
  }
  if (!preflight.hardened_runtime) {
    preflight.reason = "hardened-runtime-missing";
    return preflight;
  }
  if (preflight.forbidden_entitlements_present) {
    preflight.reason = "forbidden-entitlement";
    return preflight;
  }
  if (!preflight.entitlements_empty) {
    preflight.reason = "unexpected-entitlements";
    return preflight;
  }
  if (!preflight.static_code_created || !preflight.resource_seal_valid) {
    preflight.reason = "resource-seal-invalid";
    return preflight;
  }
  if (!preflight.identifier_matched) {
    preflight.reason = "identifier-mismatch";
    return preflight;
  }
  if (!preflight.leaf_pin_matched) {
    preflight.reason = "leaf-pin-mismatch";
    return preflight;
  }
  if (!preflight.designated_requirement_matched) {
    preflight.reason = "designated-requirement-mismatch";
    return preflight;
  }

  preflight.ok = true;
  preflight.reason = "accepted";
  return preflight;
}

}  // namespace zody::cua::round11
