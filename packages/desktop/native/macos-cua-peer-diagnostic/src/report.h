#pragma once

#include <mach/message.h>

#include <string>
#include <vector>

#include "peer_socket.h"
#include "policy.h"
#include "profile.h"
#include "security_identity.h"
#include "static_artifact.h"

void emit_blocked_report(const std::string& mode, const std::string& reason,
                         const std::vector<std::string>& errors);
void emit_transport_error_report(const std::string& mode, const std::string& reason,
                                 int error);
void emit_peer_report(const std::string& mode, const PeerToken& token, int expected_pid,
                      uint32_t expected_uid, const SecurityObservation& security,
                      const StaticArtifactObservation& static_artifact,
                      const PolicyDecision& decision, bool calibration_only);
std::string render_peer_report(const std::string& mode, const PeerToken& token, int expected_pid,
                               uint32_t expected_uid, const SecurityObservation& security,
                               const StaticArtifactObservation& static_artifact,
                               const PolicyDecision& decision, bool calibration_only);
void emit_synthetic_report(const ExpectedProfile& profile, const PolicyFacts& facts,
                           const PolicyDecision& decision);
void emit_client_report(bool connected, int response_bytes, const std::string& reason);
