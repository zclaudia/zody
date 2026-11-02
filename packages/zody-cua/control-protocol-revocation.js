import { fail } from "./control-protocol-limits.js";
import { immutableControlValue, readStrictObject } from "./control-protocol-json.js";
import { readBoolean, readIdentifier, readPositiveSafeInteger } from "./control-protocol-schema.js";

const REVOCATION_STATE_KEYS = ["submissionLineageId", "authorizationRevision", "revoked"];
const REVOCATION_INPUT_KEYS = ["submissionLineageId", "authorizationRevision"];

function normalizeRevocationState(value, path) {
  const fields = readStrictObject(value, REVOCATION_STATE_KEYS, path);
  return {
    submissionLineageId: readIdentifier(fields.submissionLineageId, `${path}.submissionLineageId`),
    authorizationRevision: readPositiveSafeInteger(
      fields.authorizationRevision,
      `${path}.authorizationRevision`,
    ),
    revoked: readBoolean(fields.revoked, `${path}.revoked`),
  };
}

function normalizeRevocationInput(value) {
  const fields = readStrictObject(value, REVOCATION_INPUT_KEYS, "revocation input");
  return {
    submissionLineageId: readIdentifier(
      fields.submissionLineageId,
      "revocation input.submissionLineageId",
    ),
    authorizationRevision: readPositiveSafeInteger(
      fields.authorizationRevision,
      "revocation input.authorizationRevision",
    ),
  };
}

export function createControlRevocation(input) {
  const fields = normalizeRevocationInput(input);
  return immutableControlValue({ ...fields, revoked: false });
}

export function applyControlRevocation(state, input) {
  const current = normalizeRevocationState(state, "revocation state");
  const nextInput = normalizeRevocationInput(input);
  if (nextInput.submissionLineageId !== current.submissionLineageId) {
    fail("lineage_mismatch", "revocation lineage does not match the state");
  }
  if (nextInput.authorizationRevision < current.authorizationRevision) {
    return immutableControlValue({
      applied: false,
      reason: "stale_revision",
      state: current,
    });
  }
  if (current.revoked) {
    const next =
      nextInput.authorizationRevision > current.authorizationRevision
        ? { ...current, authorizationRevision: nextInput.authorizationRevision }
        : current;
    return immutableControlValue({ applied: false, reason: "already_revoked", state: next });
  }
  return immutableControlValue({
    applied: true,
    reason: "revoked",
    state: { ...current, authorizationRevision: nextInput.authorizationRevision, revoked: true },
  });
}
