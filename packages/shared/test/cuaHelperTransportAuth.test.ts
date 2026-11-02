import { describe, expect, it } from "vitest";
import {
  assertTransportAuthenticationKey,
  computeHelperTransportProof,
  generateTransportChallenge,
  parseHelperProofErrorLine,
  parseHelperProofLine,
  parseHelperProofRequestLine,
  serializeHelperProof,
  serializeHelperProofRequest,
  transportProofCanonical,
  verifyHelperTransportProof,
} from "../src/cua-helper-transport-auth.js";

const KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const CELL_CHALLENGE = "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";
const SOURCE = "ab".repeat(32);
const CELL_CANONICAL =
  "zody.cua.desktop-session.transport.helper-proof|1|cell|" +
  "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f|" +
  "abababababababababababababababababababababababababababababababab|" +
  "1048576|33554432";
const CELL_PROOF = "48277697171fa3dba2d07f79c6742298911db86b7547829279bfbc6ab05e262a";
const AUTHORITY_CHALLENGE = "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f";
const AUTHORITY_CANONICAL =
  "zody.cua.desktop-session.transport.helper-proof|1|authority|" +
  "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f||0|0";
const AUTHORITY_PROOF = "b66d931b52624486cee1255b526da92ef8f3e3f94e0474311de38a9f4ab8dd06";

describe("CUA helper transport auth", () => {
  it("matches the CommonCrypto/Node shared vectors", () => {
    expect(
      transportProofCanonical("cell", CELL_CHALLENGE, SOURCE, 1024 * 1024, 32 * 1024 * 1024),
    ).toBe(CELL_CANONICAL);
    expect(computeHelperTransportProof(KEY, CELL_CANONICAL)).toBe(CELL_PROOF);
    expect(verifyHelperTransportProof(KEY, CELL_CANONICAL, CELL_PROOF)).toBe(true);

    expect(transportProofCanonical("authority", AUTHORITY_CHALLENGE, "", 0, 0)).toBe(
      AUTHORITY_CANONICAL,
    );
    expect(computeHelperTransportProof(KEY, AUTHORITY_CANONICAL)).toBe(AUTHORITY_PROOF);
    expect(verifyHelperTransportProof(KEY, AUTHORITY_CANONICAL, AUTHORITY_PROOF)).toBe(true);
  });

  it("rejects cross-role, replay, wrong and truncated proofs", () => {
    expect(verifyHelperTransportProof(KEY, CELL_CANONICAL, AUTHORITY_PROOF)).toBe(false);
    expect(verifyHelperTransportProof(KEY, AUTHORITY_CANONICAL, CELL_PROOF)).toBe(false);
    const otherChallenge = "50".repeat(32);
    const replayed = transportProofCanonical("authority", otherChallenge, "", 0, 0);
    expect(verifyHelperTransportProof(KEY, replayed, AUTHORITY_PROOF)).toBe(false);
    expect(verifyHelperTransportProof(KEY, AUTHORITY_CANONICAL, "0".repeat(64))).toBe(false);
    expect(verifyHelperTransportProof(KEY, AUTHORITY_CANONICAL, AUTHORITY_PROOF.slice(0, 63))).toBe(
      false,
    );
  });

  it("requires strict keys, challenges and role-specific fields", () => {
    expect(() => assertTransportAuthenticationKey("A".repeat(64))).toThrow();
    expect(() => assertTransportAuthenticationKey("a".repeat(63))).toThrow();
    expect(() => assertTransportAuthenticationKey(undefined)).toThrow();
    expect(() => transportProofCanonical("cell", "c".repeat(64), "", 1, 1)).toThrow();
    expect(() => transportProofCanonical("cell", "c".repeat(64), SOURCE, 0, 1)).toThrow();
    expect(() => transportProofCanonical("authority", "c".repeat(64), SOURCE, 0, 0)).toThrow();
    expect(() => transportProofCanonical("authority", "c".repeat(64), "", 1, 0)).toThrow();
    expect(() => transportProofCanonical("authority", "C".repeat(64), "", 0, 0)).toThrow();
    expect(() => transportProofCanonical("authority", "c".repeat(63), "", 0, 0)).toThrow();
    expect(() => transportProofCanonical("authority", "c".repeat(64), "", 0, 0)).not.toThrow();
    expect(() =>
      serializeHelperProof("admin" as never, AUTHORITY_CHALLENGE, AUTHORITY_PROOF),
    ).toThrow(/proof_invalid/u);
  });

  it("round-trips strict proof request and proof frames", () => {
    const cellRequest = {
      role: "cell" as const,
      challenge: CELL_CHALLENGE,
      sourceSha256: SOURCE,
      requestMaxBytes: 1024 * 1024,
      responseMaxBytes: 32 * 1024 * 1024,
    };
    expect(parseHelperProofRequestLine(serializeHelperProofRequest(cellRequest).trim())).toEqual(
      cellRequest,
    );
    const authorityRequest = {
      role: "authority" as const,
      challenge: AUTHORITY_CHALLENGE,
      sourceSha256: "",
      requestMaxBytes: 0,
      responseMaxBytes: 0,
    };
    expect(
      parseHelperProofRequestLine(serializeHelperProofRequest(authorityRequest).trim()),
    ).toEqual(authorityRequest);

    const proof = parseHelperProofLine(
      serializeHelperProof("authority", AUTHORITY_CHALLENGE, AUTHORITY_PROOF).trim(),
    );
    expect(proof).toEqual({
      schemaVersion: 1,
      type: "helper-proof",
      role: "authority",
      challenge: AUTHORITY_CHALLENGE,
      proof: AUTHORITY_PROOF,
    });
  });

  it("rejects malformed proof request/proof frames without throwing non-strict values", () => {
    const authority = serializeHelperProofRequest({
      role: "authority",
      challenge: AUTHORITY_CHALLENGE,
      sourceSha256: "",
      requestMaxBytes: 0,
      responseMaxBytes: 0,
    }).trim();
    const replacements: Array<[string, string]> = [
      ['"schemaVersion":1', '"schemaVersion":true'],
      ['"schemaVersion":1', '"schemaVersion":"1"'],
      ['"type":"helper-proof-request"', '"type":1'],
      ['"type":"helper-proof-request"', '"type":true'],
      ['"role":"authority"', '"role":1'],
      ['"role":"authority"', '"role":"admin"'],
      [`"challenge":"${AUTHORITY_CHALLENGE}"`, '"challenge":true'],
      [`"challenge":"${AUTHORITY_CHALLENGE}"`, `"challenge":"${"A".repeat(64)}"`],
      [`"challenge":"${AUTHORITY_CHALLENGE}"`, `"challenge":"${"a".repeat(63)}"`],
      ['"sourceSha256":""', `"sourceSha256":"${SOURCE}"`],
      ['"requestMaxBytes":0', '"requestMaxBytes":true'],
      ['"requestMaxBytes":0', '"requestMaxBytes":"0"'],
      ['"requestMaxBytes":0', '"requestMaxBytes":1'],
      ['"requestMaxBytes":0', '"requestMaxBytes":1e400'],
      ['"responseMaxBytes":0', '"responseMaxBytes":1.5'],
    ];
    for (const [from, to] of replacements) {
      const malformed = authority.replace(from, to);
      expect(malformed).not.toBe(authority);
      expect(() => parseHelperProofRequestLine(malformed)).toThrow();
    }
    expect(() =>
      parseHelperProofRequestLine(authority.replace('"responseMaxBytes":0', "")),
    ).toThrow();
    expect(() => parseHelperProofRequestLine(`{${authority.slice(1, -1)},"extra":1}`)).toThrow();
    expect(() => parseHelperProofRequestLine("{}")).toThrow();
    expect(() => parseHelperProofRequestLine("[]")).toThrow();
    expect(() =>
      parseHelperProofLine('{"schemaVersion":1,"type":"helper-proof","role":1}'),
    ).toThrow();
    expect(() =>
      parseHelperProofLine(
        '{"schemaVersion":1,"type":"helper-proof","role":"cell","challenge":true,"proof":true}',
      ),
    ).toThrow();
  });

  it("parses only fixed helper-proof-error frames", () => {
    expect(
      parseHelperProofErrorLine(
        JSON.stringify({
          schemaVersion: 1,
          type: "helper-proof-error",
          reason: "authority-transport-role-invalid",
        }),
      ),
    ).toBe("authority-transport-role-invalid");
    expect(
      parseHelperProofErrorLine(
        JSON.stringify({ schemaVersion: 1, type: "helper-proof-error", reason: "bad\nreason" }),
      ),
    ).toBeUndefined();
    expect(
      parseHelperProofErrorLine(JSON.stringify({ schemaVersion: 1, type: "other", reason: "x" })),
    ).toBeUndefined();
  });

  it("generates a fresh 256-bit lowercase challenge", () => {
    const first = generateTransportChallenge();
    const second = generateTransportChallenge();
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toBe(second);
  });
});
