#include "security_identity.h"

#import <CommonCrypto/CommonDigest.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>

#include <cstring>
#include <string>

namespace {

std::string cf_string(CFStringRef value) {
  if (value == nullptr) {
    return "";
  }
  const CFIndex length = CFStringGetLength(value);
  const CFIndex maximum = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  std::string result(static_cast<size_t>(maximum), '\0');
  if (!CFStringGetCString(value, result.data(), maximum, kCFStringEncodingUTF8)) {
    return "";
  }
  result.resize(std::strlen(result.c_str()));
  return result;
}

std::string sha_hex(const uint8_t* digest, size_t length) {
  static const char* hex = "0123456789abcdef";
  std::string result;
  result.reserve(length * 2);
  for (size_t index = 0; index < length; ++index) {
    result.push_back(hex[(digest[index] >> 4) & 0x0f]);
    result.push_back(hex[digest[index] & 0x0f]);
  }
  return result;
}

std::string canonical_json(CFTypeRef value) {
  if (value == nullptr) {
    return "";
  }
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:(__bridge id)value
                                                 options:NSJSONWritingSortedKeys
                                                   error:&error];
  if (data == nil || error != nil) {
    return "";
  }
  NSString* text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  return text == nil ? "" : std::string([text UTF8String]);
}

}  // namespace

SecurityObservation inspect_peer_security(const audit_token_t& token,
                                          const ExpectedProfile& profile) {
  SecurityObservation observation;
  observation.executed = true;
  observation.expected_designated_requirement = profile.designated_requirement;

  CFDataRef token_data = CFDataCreate(nullptr, reinterpret_cast<const UInt8*>(&token), sizeof(token));
  if (token_data == nullptr) {
    observation.guest_status = errSecAllocate;
    return observation;
  }
  const void* keys[] = {kSecGuestAttributeAudit};
  const void* values[] = {token_data};
  CFDictionaryRef attributes = CFDictionaryCreate(
      nullptr, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFRelease(token_data);
  if (attributes == nullptr) {
    observation.guest_status = errSecAllocate;
    return observation;
  }

  SecCodeRef code = nullptr;
  observation.guest_status = SecCodeCopyGuestWithAttributes(
      nullptr, attributes, kSecCSDefaultFlags, &code);
  CFRelease(attributes);
  observation.guest_created = observation.guest_status == errSecSuccess && code != nullptr;
  if (!observation.guest_created) {
    if (code != nullptr) {
      CFRelease(code);
    }
    return observation;
  }

  SecRequirementRef expected_requirement = nullptr;
  CFStringRef requirement_text = CFStringCreateWithCString(
      nullptr, profile.designated_requirement.c_str(), kCFStringEncodingUTF8);
  if (requirement_text != nullptr) {
    observation.requirement_status = SecRequirementCreateWithString(
        requirement_text, kSecCSDefaultFlags, &expected_requirement);
    CFRelease(requirement_text);
  } else {
    observation.requirement_status = errSecAllocate;
  }

  observation.validity_status = SecCodeCheckValidity(code, kSecCSDefaultFlags, nullptr);
  observation.code_valid = observation.validity_status == errSecSuccess;
  if (expected_requirement != nullptr) {
    observation.requirement_matched =
        SecCodeCheckValidity(code, kSecCSDefaultFlags, expected_requirement) == errSecSuccess;
  }

  SecStaticCodeRef static_code = nullptr;
  observation.static_code_status = SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &static_code);
  observation.static_code_created =
      observation.static_code_status == errSecSuccess && static_code != nullptr;
  if (observation.static_code_created) {
    CFURLRef path_url = nullptr;
    if (SecCodeCopyPath(static_code, kSecCSDefaultFlags, &path_url) == errSecSuccess &&
        path_url != nullptr) {
      CFStringRef path = CFURLCopyFileSystemPath(path_url, kCFURLPOSIXPathStyle);
      observation.executable_path = cf_string(path);
      if (path != nullptr) {
        CFRelease(path);
      }
      CFRelease(path_url);
    }

    CFDictionaryRef information = nullptr;
    observation.signing_status = SecCodeCopySigningInformation(
        static_code, kSecCSSigningInformation | kSecCSRequirementInformation, &information);
    observation.signing_info_available =
        observation.signing_status == errSecSuccess && information != nullptr;
    if (observation.signing_info_available) {
      CFTypeRef identifier = CFDictionaryGetValue(information, kSecCodeInfoIdentifier);
      if (identifier != nullptr && CFGetTypeID(identifier) == CFStringGetTypeID()) {
        observation.identifier = cf_string(static_cast<CFStringRef>(identifier));
      }
      CFTypeRef flags = CFDictionaryGetValue(information, kSecCodeInfoFlags);
      if (flags != nullptr && CFGetTypeID(flags) == CFNumberGetTypeID()) {
        CFNumberGetValue(static_cast<CFNumberRef>(flags), kCFNumberSInt32Type, &observation.flags);
        observation.adhoc = (observation.flags & kSecCodeSignatureAdhoc) != 0;
      }
      CFTypeRef certificates = CFDictionaryGetValue(information, kSecCodeInfoCertificates);
      if (certificates != nullptr && CFGetTypeID(certificates) == CFArrayGetTypeID()) {
        CFArrayRef array = static_cast<CFArrayRef>(certificates);
        observation.certificate_count = static_cast<size_t>(CFArrayGetCount(array));
        observation.certificate_present = observation.certificate_count > 0;
        if (observation.certificate_present) {
          SecCertificateRef leaf = reinterpret_cast<SecCertificateRef>(
              const_cast<void*>(CFArrayGetValueAtIndex(array, 0)));
          CFDataRef der = SecCertificateCopyData(leaf);
          if (der != nullptr) {
            const UInt8* bytes = CFDataGetBytePtr(der);
            const CFIndex length = CFDataGetLength(der);
            uint8_t sha256[CC_SHA256_DIGEST_LENGTH];
            uint8_t sha1[CC_SHA1_DIGEST_LENGTH];
            CC_SHA256(bytes, static_cast<CC_LONG>(length), sha256);
            CC_SHA1(bytes, static_cast<CC_LONG>(length), sha1);
            observation.leaf_sha256 = sha_hex(sha256, sizeof(sha256));
            observation.leaf_sha1 = sha_hex(sha1, sizeof(sha1));
            observation.leaf_sha256_matched =
                observation.leaf_sha256 == profile.leaf_certificate_sha256;
            observation.leaf_sha1_matched = observation.leaf_sha1 == profile.certificate_sha1;
            CFRelease(der);
          }
        }
      }
      CFTypeRef entitlements = CFDictionaryGetValue(information, kSecCodeInfoEntitlementsDict);
      if (entitlements != nullptr && CFGetTypeID(entitlements) == CFDictionaryGetTypeID()) {
        observation.entitlements_present = true;
        observation.entitlements_json = canonical_json(entitlements);
      }
      CFTypeRef designated = CFDictionaryGetValue(information, kSecCodeInfoDesignatedRequirement);
      if (designated != nullptr && CFGetTypeID(designated) == SecRequirementGetTypeID()) {
        CFStringRef designated_text = nullptr;
        if (SecRequirementCopyString(reinterpret_cast<SecRequirementRef>(
                                         const_cast<void*>(designated)),
                                     kSecCSDefaultFlags, &designated_text) == errSecSuccess &&
            designated_text != nullptr) {
          observation.designated_requirement = cf_string(designated_text);
          CFRelease(designated_text);
          std::string stored_identifier;
          std::string stored_certificate_sha1;
          if (parse_narrow_requirement(observation.designated_requirement, stored_identifier,
                                       stored_certificate_sha1)) {
            observation.stored_dr_strict_policy_matched =
                stored_identifier == profile.bundle_id &&
                stored_certificate_sha1 == profile.certificate_sha1;
          }
        }
      }
      CFRelease(information);
    }
  }
  if (static_code != nullptr) {
    CFRelease(static_code);
  }
  if (expected_requirement != nullptr) {
    CFRelease(expected_requirement);
  }
  CFRelease(code);
  return observation;
}
