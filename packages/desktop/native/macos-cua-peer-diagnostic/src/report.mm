#import <Foundation/Foundation.h>

#include "report.h"

#include <cstdio>
#include <string>

namespace {

NSString* ns(const std::string& value) {
  NSString* text = [NSString stringWithUTF8String:value.c_str()];
  return text == nil ? @"" : text;
}

NSNumber* number(int value) { return [NSNumber numberWithInt:value]; }
NSNumber* number_u(uint32_t value) { return [NSNumber numberWithUnsignedInt:value]; }
NSNumber* number_s(size_t value) { return [NSNumber numberWithUnsignedLong:value]; }
NSNumber* boolean(bool value) { return [NSNumber numberWithBool:value]; }

NSMutableDictionary* safety() {
  return [@{
    @"schemaVersion" : @1,
    @"kind" : @"zody-cua-peer-diagnostic-report",
    @"diagnosticOnly" : @YES,
    @"grant" : @NO,
    @"nativeCapabilityProven" : @NO,
    @"runtimeConsumable" : @NO,
    @"productHook" : @NO,
  } mutableCopy];
}

void emit(NSDictionary* report) {
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:report options:0 error:&error];
  if (data == nil || error != nil) {
    std::fputs("{\"schemaVersion\":1,\"kind\":\"zody-cua-peer-diagnostic-report\",\"status\":\"error\",\"reason\":\"json-serialization-failed\",\"diagnosticOnly\":true,\"grant\":false,\"nativeCapabilityProven\":false,\"runtimeConsumable\":false,\"productHook\":false}\n",
               stdout);
    return;
  }
  NSString* text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  std::fputs([text UTF8String], stdout);
  std::fputc('\n', stdout);
}

NSArray* strings(const std::vector<std::string>& values) {
  NSMutableArray* array = [NSMutableArray arrayWithCapacity:values.size()];
  for (const std::string& value : values) {
    [array addObject:ns(value)];
  }
  return array;
}

NSDictionary* peer_dictionary(const PeerToken& token, int expected_pid, uint32_t expected_uid) {
  return @{
    @"transport" : @"af_unix",
    @"peerTokenSource" : @"getsockopt(LOCAL_PEERTOKEN)",
    @"auditTokenCaptured" : boolean(token.captured),
    @"usesPidFallback" : @NO,
    @"auditTokenFields" : @[ @"pid", @"euid", @"auid", @"ruid", @"rgid", @"asid", @"pidversion" ],
    @"pidObserved" : number(token.pid),
    @"pidExpected" : number(expected_pid),
    @"pidMatched" : boolean(token.pid == expected_pid),
    @"euidObserved" : number_u(token.euid),
    @"euidExpected" : number_u(expected_uid),
    @"euidMatched" : boolean(token.euid == expected_uid),
    @"auidObserved" : number_u(token.auid),
    @"ruidObserved" : number_u(token.ruid),
    @"rgidObserved" : number_u(token.rgid),
    @"asidObserved" : number_u(token.asid),
    @"asidExpected" : [NSNull null],
    @"asidMatched" : @"not-pinned",
    @"asidMatchMode" : @"not-pinned",
    @"pidVersionObserved" : number(token.pid_version),
    @"pidVersionExpected" : [NSNull null],
    @"pidVersionMatched" : @"not-pinned",
    @"pidVersionMatchMode" : @"not-pinned",
    @"loginSessionInferred" : @NO,
    @"parentRelationshipInferred" : @NO,
    @"uidEqualityIsNotSessionProof" : @YES,
  };
}

NSDictionary* security_dictionary(const SecurityObservation& security) {
  return @{
    @"executed" : boolean(security.executed),
    @"guestApi" : @"SecCodeCopyGuestWithAttributes",
    @"guestAttribute" : @"kSecGuestAttributeAudit",
    @"usesPidFallback" : @NO,
    @"guestCreated" : boolean(security.guest_created),
    @"guestStatus" : number(security.guest_status),
    @"codeValid" : boolean(security.code_valid),
    @"validityStatus" : number(security.validity_status),
    @"checkValidityFlags" : @"kSecCSDefaultFlags",
    @"requirementStatus" : number(security.requirement_status),
    @"requirementMatched" : boolean(security.requirement_matched),
    @"signingInfoAvailable" : boolean(security.signing_info_available),
    @"signingStatus" : number(security.signing_status),
    @"flags" : number_u(security.flags),
    @"adhoc" : boolean(security.adhoc),
    @"identifier" : ns(security.identifier),
    @"certificatePresent" : boolean(security.certificate_present),
    @"certificateCount" : number_s(security.certificate_count),
    @"leafCertificateSha256" : ns(security.leaf_sha256),
    @"leafCertificateSha1" : ns(security.leaf_sha1),
    @"designatedRequirement" : ns(security.designated_requirement),
    @"storedDrStrictPolicyMatched" : boolean(security.stored_dr_strict_policy_matched),
    @"staticCodeCreated" : boolean(security.static_code_created),
    @"staticCodeStatus" : number(security.static_code_status),
    @"executablePath" : ns(security.executable_path),
    @"entitlementsPresent" : boolean(security.entitlements_present),
    @"entitlementsJson" : ns(security.entitlements_json),
  };
}

NSDictionary* static_artifact_dictionary(const StaticArtifactObservation& artifact) {
  return @{
    @"allPerformed" : boolean(artifact.all_performed),
    @"matched" : boolean(artifact.matched),
    @"executablePath" : ns(artifact.executable_path),
    @"executableSha256" : @{
      @"expected" : ns(artifact.sha256_expected),
      @"actual" : ns(artifact.sha256_actual),
      @"matched" : boolean(artifact.sha256_matched),
    },
    @"entitlements" : @{
      @"expectedJson" : ns(artifact.entitlements_expected_json),
      @"actualJson" : ns(artifact.entitlements_actual_json),
      @"matched" : boolean(artifact.entitlements_matched),
    },
    @"architectures" : @{
      @"expected" : strings(artifact.architectures_expected),
      @"actual" : strings(artifact.architectures_actual),
      @"matched" : boolean(artifact.architectures_matched),
    },
    @"minimumMacOS" : @{
      @"expected" : ns(artifact.minimum_macos_expected),
      @"actual" : ns(artifact.minimum_macos_actual),
      @"matched" : boolean(artifact.minimum_macos_matched),
    },
    @"errors" : strings(artifact.errors),
  };
}

}  // namespace

void emit_blocked_report(const std::string& mode, const std::string& reason,
                         const std::vector<std::string>& errors) {
  NSMutableDictionary* report = safety();
  report[@"status"] = @"blocked";
  report[@"mode"] = ns(mode);
  report[@"reason"] = ns(reason);
  report[@"errors"] = strings(errors);
  report[@"helperAuthorization"] = @"blocked";
  emit(report);
}

void emit_transport_error_report(const std::string& mode, const std::string& reason, int error) {
  NSMutableDictionary* report = safety();
  report[@"status"] = @"error";
  report[@"mode"] = ns(mode);
  report[@"reason"] = ns(reason);
  report[@"errorNumber"] = number(error);
  report[@"helperAuthorization"] = @"blocked";
  emit(report);
}

static NSDictionary* make_peer_report(const std::string& mode, const PeerToken& token,
                                      int expected_pid, uint32_t expected_uid,
                                      const SecurityObservation& security,
                                      const StaticArtifactObservation& static_artifact,
                                      const PolicyDecision& decision, bool calibration_only) {
  NSMutableDictionary* report = safety();
  report[@"status"] = decision.accepted ? @"accept" : @"reject";
  report[@"mode"] = ns(mode);
  report[@"peer"] = peer_dictionary(token, expected_pid, expected_uid);
  report[@"security"] = security_dictionary(security);
  report[@"staticArtifact"] = static_artifact_dictionary(static_artifact);
  report[@"decision"] = @{@"accepted" : boolean(decision.accepted), @"reason" : ns(decision.reason)};
  report[@"helperAuthorization"] = @"blocked";
  report[@"checkedScope"] = @[
    @"AF_UNIX LOCAL_PEERTOKEN full audit token",
    @"SecCodeCopyGuestWithAttributes(kSecGuestAttributeAudit)",
    @"SecCodeCheckValidity and signing information",
    @"leaf DER SHA-256, identifier and narrow designated requirement",
    @"actual static executable SHA-256, entitlements, architecture and minimum macOS",
  ];
  report[@"notPerformed"] = @[
    @"TCC authorization", @"machine lease", @"native input or screenshots",
    @"product runtime consumption", @"positive local-self-signed Helper",
    @"bundle ShortVersion/Version/executableName against the actual bundle",
    @"full 12-field static doctor"
  ];
  report[@"profileValidationScope"] = @"12-field schema plus identity policy only; bundle metadata and a full static doctor are not performed";
  if (calibration_only) {
    report[@"calibrationOnly"] = @YES;
    report[@"nodeSignatureMechanismControl"] = @YES;
    report[@"localSelfSignedHelperAcceptance"] = @NO;
    report[@"attestsLoadedJs"] = @NO;
    report[@"lowerLayerSecurityControl"] = @{
      @"guestCreated" : boolean(security.guest_created),
      @"codeValid" : boolean(security.code_valid),
      @"leafRequirementMatched" : boolean(security.requirement_matched),
      @"leafCertificatePresent" : boolean(security.certificate_present),
      @"leafSha256Matched" : boolean(security.leaf_sha256_matched),
      @"leafSha1Matched" : boolean(security.leaf_sha1_matched),
    };
    report[@"strictLocalSelfSignedDr"] = @{
      @"expected" : ns(security.expected_designated_requirement),
      @"stored" : ns(security.designated_requirement),
      @"storedStrictlyMatched" : boolean(security.stored_dr_strict_policy_matched),
    };
    report[@"calibrationNote"] = @"Node signature mechanism control only; not Zody Helper acceptance and not attestation of loaded JavaScript.";
  }
  return report;
}

std::string render_peer_report(const std::string& mode, const PeerToken& token, int expected_pid,
                               uint32_t expected_uid, const SecurityObservation& security,
                               const StaticArtifactObservation& static_artifact,
                               const PolicyDecision& decision, bool calibration_only) {
  NSDictionary* report = make_peer_report(mode, token, expected_pid, expected_uid, security,
                                          static_artifact, decision, calibration_only);
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:report options:0 error:&error];
  if (data == nil || error != nil) {
    return "";
  }
  NSString* text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  return text == nil ? "" : std::string([text UTF8String]);
}

void emit_peer_report(const std::string& mode, const PeerToken& token, int expected_pid,
                      uint32_t expected_uid, const SecurityObservation& security,
                      const StaticArtifactObservation& static_artifact,
                      const PolicyDecision& decision, bool calibration_only) {
  const std::string text = render_peer_report(mode, token, expected_pid, expected_uid, security,
                                              static_artifact, decision, calibration_only);
  if (text.empty()) {
    emit_transport_error_report(mode, "json-serialization-failed", 0);
    return;
  }
  std::fputs(text.c_str(), stdout);
  std::fputc('\n', stdout);
}

void emit_synthetic_report(const ExpectedProfile& profile, const PolicyFacts& facts,
                           const PolicyDecision& decision) {
  NSMutableDictionary* report = safety();
  report[@"status"] = decision.accepted ? @"synthetic-policy-pass" : @"reject";
  report[@"mode"] = @"pure-policy-check";
  report[@"pureTestOnly"] = @YES;
  report[@"syntheticFacts"] = @YES;
  report[@"nativeSecurityExecuted"] = @NO;
  report[@"peerFrameReachable"] = @NO;
  report[@"productionInputReachable"] = @NO;
  report[@"decision"] = @{@"accepted" : boolean(decision.accepted), @"reason" : ns(decision.reason)};
  report[@"facts"] = @{
    @"identifier" : ns(facts.identifier),
    @"leafCertificateSha256" : ns(facts.leaf_sha256),
    @"leafCertificateSha1" : ns(facts.leaf_sha1),
    @"designatedRequirement" : ns(facts.designated_requirement),
    @"adhoc" : boolean(facts.adhoc),
    @"certificatePresent" : boolean(facts.certificate_present),
    @"codeValid" : boolean(facts.code_valid),
  };
  report[@"expected"] = @{
    @"identifier" : ns(profile.bundle_id),
    @"leafCertificateSha256" : ns(profile.leaf_certificate_sha256),
    @"certificateSha1" : ns(profile.certificate_sha1),
    @"designatedRequirement" : ns(profile.designated_requirement),
  };
  report[@"helperAuthorization"] = @"blocked";
  emit(report);
}

void emit_client_report(bool connected, int response_bytes, const std::string& reason) {
  NSMutableDictionary* report = safety();
  report[@"role"] = @"client";
  report[@"status"] = connected ? @"connected" : @"error";
  report[@"responseBytes"] = number(response_bytes);
  if (!reason.empty()) {
    report[@"reason"] = ns(reason);
  }
  emit(report);
}
