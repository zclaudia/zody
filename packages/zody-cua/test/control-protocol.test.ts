import { generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CONTROL_LIMITS,
  ControlProtocolError,
  admitControlSequence,
  applyControlRevocation,
  canonicalizeControlJson,
  createControlRequest,
  createControlReplayWindow,
  createControlRevocation,
  digestControlPayload,
  evaluateControlAck,
  signControlBody,
  verifyControlEnvelope,
} from "../control-protocol.js";
import type {
  ControlAckBody,
  ControlBinding,
  ControlDirection,
  ControlReplayEntry,
  ControlReplayWindowState,
  ControlRequestBody,
  CreateControlRequestInput,
} from "../control-protocol.js";
import { createComputerUseRuntime } from "../index.js";

const controllerKeys = generateKeyPairSync("ed25519");
const producerKeys = generateKeyPairSync("ed25519");
const otherKeys = generateKeyPairSync("ed25519");
const ecKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });

const controllerTrust = { "controller-key": controllerKeys.publicKey };
const producerTrust = { "producer-key": producerKeys.publicKey };
const bothTrust = {
  "controller-key": controllerKeys.publicKey,
  "other-key": otherKeys.publicKey,
  "producer-key": producerKeys.publicKey,
};

const binding: ControlBinding = {
  channelId: "channel-1",
  controllerIncarnation: "controller-6f1c2c9e-2f3a-4f7b-9a11-0e6d7b3c1a20",
  producerIncarnation: "producer-1b7e3e2a-8e4d-4d09-a3f2-6c2b1d0e9f10",
  appIncarnation: "app-8f2a1c3d-4e5b-4a6c-9d7e-2f1a0b3c4d5e",
};

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (!(error instanceof ControlProtocolError)) {
      throw error;
    }
    return error.code;
  }
  throw new Error("expected ControlProtocolError");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function makeRequest(
  overrides: Partial<CreateControlRequestInput> = {},
  key: KeyObject = controllerKeys.privateKey,
) {
  return createControlRequest(
    {
      keyId: "controller-key",
      direction: "controller_to_producer",
      binding,
      messageId: "msg-request-1",
      sequence: 1,
      submissionLineageId: "lineage-1",
      authorizationRevision: 1,
      operation: "stop",
      ...overrides,
    },
    key,
  );
}

function verifyRequest(
  envelope: unknown,
  trust: Record<string, KeyObject> = controllerTrust,
  expectedDirection: ControlDirection = "controller_to_producer",
) {
  return verifyControlEnvelope(envelope, {
    trustedKeys: trust,
    expectedKind: "request",
    expectedDirection,
    expectedBinding: binding,
  });
}

function verifyAck(
  envelope: unknown,
  trust: Record<string, KeyObject> = producerTrust,
  expectedDirection: ControlDirection = "producer_to_controller",
) {
  return verifyControlEnvelope(envelope, {
    trustedKeys: trust,
    expectedKind: "ack",
    expectedDirection,
    expectedBinding: binding,
  });
}

function makeAckBody(
  request: ControlRequestBody,
  overrides: Partial<ControlAckBody> = {},
): ControlAckBody {
  return {
    keyId: "producer-key",
    kind: "ack",
    direction: "producer_to_controller",
    binding: request.binding,
    messageId: "msg-ack-1",
    sequence: 1,
    replyToMessageId: request.messageId,
    replyToSequence: request.sequence,
    replyToPayloadDigest: request.payloadDigest,
    submissionLineageId: request.submissionLineageId,
    authorizationRevision: request.authorizationRevision,
    phase: "drained",
    facts: {
      projection: { admissionClosed: true, projectionApplied: true },
      revoked: { authorizationRevoked: true },
      stop: {
        nativeFenced: true,
        pending: false,
        ownedInputsReleased: true,
        leaseReleased: true,
      },
    },
    ...overrides,
  };
}

function signAck(ack: ControlAckBody, key: KeyObject = producerKeys.privateKey) {
  return signControlBody(ack, key);
}

function makeReplayEntry(
  sequence: number,
  bodyDigest: string,
  overrides: Partial<ControlReplayEntry> = {},
): ControlReplayEntry {
  return {
    sequence,
    messageId: `replay-${sequence}`,
    bodyDigest,
    binding,
    direction: "controller_to_producer",
    ...overrides,
  };
}

describe("package regression", () => {
  it("keeps the original runtime unavailable", async () => {
    const runtime = createComputerUseRuntime();
    const context = { sessionId: "session-1", runtimeScope: "main" as const, workspaceKey: "w" };
    await expect(runtime.execute({ toolName: "screenshot", context })).resolves.toEqual({
      content: [{ type: "text", text: "Computer Use is not available in this build." }],
      isError: true,
    });
    await expect(runtime.closeSession(context)).resolves.toBeUndefined();
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });

  it("preserves placeholder exports alongside the candidate control subpaths", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { zcodeCuaPlaceholder?: boolean; exports?: Record<string, unknown> };
    expect(packageJson.zcodeCuaPlaceholder).toBe(true);
    expect(Object.keys(packageJson.exports ?? {})).toEqual([
      ".",
      "./frame-contract",
      "./host-display-contract",
      "./request-access-contract",
      "./pip-session",
      "./pip-session/node",
      "./broker",
      "./broker/server",
      "./broker/ports",
      "./broker/socketPath",
      "./broker/helperConstants",
      "./broker/helperHealth",
      "./control-protocol",
      "./control-channel",
      "./producer-control",
    ]);
    expect(packageJson.exports?.["./control-protocol"]).toEqual({
      types: "./control-protocol.d.ts",
      import: "./control-protocol.js",
    });
    expect(packageJson.exports?.["./control-channel"]).toEqual({
      types: "./control-channel.d.ts",
      import: "./control-channel.js",
    });
    expect(packageJson.exports?.["./producer-control"]).toEqual({
      types: "./producer-control.d.ts",
      import: "./producer-control.js",
    });
  });

  it("exposes callable JavaScript implementations", () => {
    expect(typeof canonicalizeControlJson).toBe("function");
    expect(typeof digestControlPayload).toBe("function");
    expect(typeof createControlRequest).toBe("function");
    expect(typeof signControlBody).toBe("function");
    expect(typeof verifyControlEnvelope).toBe("function");
    expect(typeof createControlReplayWindow).toBe("function");
    expect(typeof admitControlSequence).toBe("function");
    expect(typeof createControlRevocation).toBe("function");
    expect(typeof applyControlRevocation).toBe("function");
    expect(typeof evaluateControlAck).toBe("function");
  });
});

describe("canonical JSON", () => {
  it("sorts object keys and keeps array order", () => {
    expect(canonicalizeControlJson({ b: [true, null], a: "x" })).toBe('{"a":"x","b":[true,null]}');
    expect(canonicalizeControlJson(Object.create(null) as object)).toBe("{}");
    expect(digestControlPayload({ a: 1, b: 2 })).toBe(digestControlPayload({ b: 2, a: 1 }));
    expect(digestControlPayload({ operation: "stop" })).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects unsafe objects and values", () => {
    const getter = {};
    Object.defineProperty(getter, "a", { enumerable: true, get: () => 1 });
    expect(errorCode(() => canonicalizeControlJson(getter))).toBe("unsafe_object");

    const hidden = {};
    Object.defineProperty(hidden, "a", { enumerable: false, value: 1 });
    expect(errorCode(() => canonicalizeControlJson(hidden))).toBe("unsafe_object");

    const symbol = { a: 1, [Symbol("x")]: 2 };
    expect(errorCode(() => canonicalizeControlJson(symbol))).toBe("unsafe_object");
    expect(errorCode(() => canonicalizeControlJson(JSON.parse('{"__proto__":1,"a":2}')))).toBe(
      "unsafe_object",
    );
    expect(errorCode(() => canonicalizeControlJson(Object.create({ a: 1 })))).toBe("unsafe_object");
    expect(errorCode(() => canonicalizeControlJson(new Date()))).toBe("unsafe_object");
    expect(errorCode(() => canonicalizeControlJson(new Map()))).toBe("unsafe_object");
    expect(errorCode(() => canonicalizeControlJson(new Uint8Array([1])))).toBe("unsafe_object");

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(errorCode(() => canonicalizeControlJson(cycle))).toBe("unsafe_object");

    const sparse = [1];
    sparse.length = 2;
    expect(errorCode(() => canonicalizeControlJson(sparse))).toBe("unsafe_object");

    const extraArrayProperty = [1, 2] as unknown as Record<string, unknown>;
    extraArrayProperty.extra = true;
    expect(errorCode(() => canonicalizeControlJson(extraArrayProperty))).toBe("unsafe_object");

    expect(errorCode(() => canonicalizeControlJson(undefined))).toBe("invalid_schema");
    expect(errorCode(() => canonicalizeControlJson(() => 1))).toBe("invalid_schema");
    expect(errorCode(() => canonicalizeControlJson(BigInt(1)))).toBe("invalid_schema");
    expect(errorCode(() => canonicalizeControlJson(1.5))).toBe("invalid_schema");
    expect(errorCode(() => canonicalizeControlJson(-0))).toBe("invalid_schema");
    expect(errorCode(() => canonicalizeControlJson(Number.NaN))).toBe("invalid_schema");
    expect(errorCode(() => canonicalizeControlJson(Number.POSITIVE_INFINITY))).toBe(
      "invalid_schema",
    );
    expect(errorCode(() => canonicalizeControlJson("\ud800"))).toBe("invalid_schema");
  });

  it("enforces depth, string, array and object budgets", () => {
    let deep: unknown = 1;
    for (let index = 0; index < 10; index += 1) {
      deep = { nested: deep };
    }
    expect(errorCode(() => canonicalizeControlJson(deep))).toBe("limit_exceeded");

    expect(
      errorCode(() => canonicalizeControlJson("x".repeat(CONTROL_LIMITS.maxStringBytes + 1))),
    ).toBe("limit_exceeded");
    expect(
      errorCode(() =>
        canonicalizeControlJson({ ["k".repeat(CONTROL_LIMITS.maxStringBytes + 1)]: 1 }),
      ),
    ).toBe("limit_exceeded");
    expect(
      errorCode(() =>
        canonicalizeControlJson(Array.from({ length: CONTROL_LIMITS.maxArrayLength + 1 }, () => 1)),
      ),
    ).toBe("limit_exceeded");

    const tooManyKeys: Record<string, number> = {};
    for (let index = 0; index <= CONTROL_LIMITS.maxObjectKeys; index += 1) {
      tooManyKeys[`k${index}`] = index;
    }
    expect(errorCode(() => canonicalizeControlJson(tooManyKeys))).toBe("limit_exceeded");
  });

  it("stops wide DAG expansion with the node budget", () => {
    let node: Record<string, unknown> = { leaf: "x" };
    for (let level = 0; level < 5; level += 1) {
      const next: Record<string, unknown> = {};
      for (let index = 0; index < 8; index += 1) {
        next[`k${index}`] = node;
      }
      node = next;
    }
    expect(errorCode(() => canonicalizeControlJson(node))).toBe("limit_exceeded");
  });

  it("counts large object keys and total bytes during traversal", () => {
    const bloated: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) {
      bloated[`k${index}`] = "x".repeat(4000);
    }
    expect(errorCode(() => canonicalizeControlJson(bloated))).toBe("limit_exceeded");
  });
});

describe("Ed25519 signing and verification", () => {
  it("verifies a real Ed25519 request", () => {
    const verified = verifyRequest(makeRequest());
    expect(verified.keyId).toBe("controller-key");
    expect(verified.body.kind).toBe("request");
    expect(verified.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts Ed25519 PEM material", () => {
    const privatePem = controllerKeys.privateKey.export({ type: "pkcs8", format: "pem" });
    const publicPem = controllerKeys.publicKey.export({ type: "spki", format: "pem" });
    const envelope = makeRequest({}, controllerKeys.privateKey);
    const verified = verifyControlEnvelope(envelope, {
      trustedKeys: { "controller-key": publicPem },
      expectedKind: "request",
      expectedDirection: "controller_to_producer",
      expectedBinding: binding,
    });
    expect(verified.body.messageId).toBe("msg-request-1");
    expect(typeof privatePem).toBe("string");
  });

  it("rejects non-Ed25519 signing and trust keys", () => {
    expect(errorCode(() => makeRequest({}, ecKeys.privateKey))).toBe("invalid_signing_key");
    expect(
      errorCode(() => verifyRequest(makeRequest(), { "controller-key": ecKeys.publicKey })),
    ).toBe("invalid_trust_store");
    expect(
      errorCode(() =>
        verifyRequest(makeRequest(), { "controller-key": controllerKeys.privateKey }),
      ),
    ).toBe("invalid_trust_store");
    expect(errorCode(() => verifyRequest(makeRequest(), {}))).toBe("invalid_trust_store");
  });

  it("rejects tampered signatures and envelope fields", () => {
    const signatureTampered = clone(makeRequest());
    signatureTampered.signature = signatureTampered.signature.replace(/^./, (char) =>
      char === "A" ? "B" : "A",
    );
    expect(errorCode(() => verifyRequest(signatureTampered))).toBe("invalid_signature");

    const protocolTampered = clone(makeRequest());
    protocolTampered.protocol = "zody.cua.control.v2" as typeof protocolTampered.protocol;
    expect(errorCode(() => verifyRequest(protocolTampered))).toBe("invalid_schema");

    const versionTampered = clone(makeRequest());
    versionTampered.version = 2 as typeof versionTampered.version;
    expect(errorCode(() => verifyRequest(versionTampered))).toBe("invalid_schema");

    const signatureShape = clone(makeRequest());
    signatureShape.signature = "not-a-signature";
    expect(errorCode(() => verifyRequest(signatureShape))).toBe("invalid_schema");
  });

  it("rejects tampering with every signed identity and request field", () => {
    const cases: Array<[string, (body: ControlRequestBody) => void, string]> = [
      ["keyId", (body) => (body.keyId = "other-key"), "untrusted_key"],
      ["kind", (body) => (body.kind = "ack" as typeof body.kind), "invalid_schema"],
      ["direction", (body) => (body.direction = "producer_to_controller"), "invalid_schema"],
      ["messageId", (body) => (body.messageId = "msg-other"), "invalid_signature"],
      ["sequence", (body) => (body.sequence = 2), "invalid_signature"],
      [
        "submissionLineageId",
        (body) => (body.submissionLineageId = "lineage-2"),
        "invalid_signature",
      ],
      ["authorizationRevision", (body) => (body.authorizationRevision = 2), "invalid_signature"],
      [
        "payload.operation",
        (body) => (body.payload.operation = "revoke_submission"),
        "invalid_schema",
      ],
      ["payloadDigest", (body) => (body.payloadDigest = "0".repeat(64)), "invalid_schema"],
      ["binding.channelId", (body) => (body.binding.channelId = "channel-2"), "invalid_signature"],
      [
        "binding.controllerIncarnation",
        (body) => (body.binding.controllerIncarnation = "controller-other"),
        "invalid_signature",
      ],
      [
        "binding.producerIncarnation",
        (body) => (body.binding.producerIncarnation = "producer-other"),
        "invalid_signature",
      ],
      [
        "binding.appIncarnation",
        (body) => (body.binding.appIncarnation = "app-other"),
        "invalid_signature",
      ],
    ];
    for (const [name, mutate, expectedCode] of cases) {
      const envelope = clone(makeRequest());
      mutate(envelope.body);
      expect(
        errorCode(() => verifyRequest(envelope)),
        name,
      ).toBe(expectedCode);
    }
  });

  it("rejects mismatched expected binding, direction and kind", () => {
    const envelope = makeRequest();
    const variants: ControlBinding[] = [
      { ...binding, channelId: "channel-other" },
      { ...binding, controllerIncarnation: "controller-other" },
      { ...binding, producerIncarnation: "producer-other" },
      { ...binding, appIncarnation: "app-other" },
    ];
    for (const expectedBinding of variants) {
      expect(
        errorCode(() =>
          verifyControlEnvelope(envelope, {
            trustedKeys: controllerTrust,
            expectedKind: "request",
            expectedDirection: "controller_to_producer",
            expectedBinding,
          }),
        ),
      ).toBe("binding_mismatch");
    }
    expect(
      errorCode(() =>
        verifyControlEnvelope(envelope, {
          trustedKeys: controllerTrust,
          expectedKind: "request",
          expectedDirection: "producer_to_controller",
          expectedBinding: binding,
        }),
      ),
    ).toBe("binding_mismatch");
    expect(
      errorCode(() =>
        verifyControlEnvelope(envelope, {
          trustedKeys: controllerTrust,
          expectedKind: "ack",
          expectedDirection: "controller_to_producer",
          expectedBinding: binding,
        }),
      ),
    ).toBe("binding_mismatch");
  });

  it("rejects ACK tampering before fact evaluation", () => {
    const verifiedRequest = verifyRequest(makeRequest());
    const ack = signAck(makeAckBody(verifiedRequest.body));
    const cases: Array<[string, (body: ControlAckBody) => void, string]> = [
      ["keyId", (body) => (body.keyId = "other-key"), "untrusted_key"],
      ["messageId", (body) => (body.messageId = "msg-other"), "invalid_signature"],
      ["sequence", (body) => (body.sequence = 2), "invalid_signature"],
      ["phase", (body) => (body.phase = "unknown"), "invalid_signature"],
      [
        "facts.projection.admissionClosed",
        (body) => (body.facts.projection.admissionClosed = false),
        "invalid_signature",
      ],
      [
        "facts.revoked.authorizationRevoked",
        (body) => (body.facts.revoked.authorizationRevoked = false),
        "invalid_signature",
      ],
      [
        "facts.stop.nativeFenced",
        (body) => {
          if (body.facts.stop) body.facts.stop.nativeFenced = false;
        },
        "invalid_signature",
      ],
    ];
    for (const [name, mutate, expectedCode] of cases) {
      const tampered = clone(ack);
      mutate(tampered.body);
      expect(
        errorCode(() => verifyAck(tampered)),
        name,
      ).toBe(expectedCode);
    }
  });

  it("uses opaque string incarnations", () => {
    expect(
      errorCode(() => makeRequest({ binding: { ...binding, controllerIncarnation: "" } })),
    ).toBe("limit_exceeded");
    expect(
      errorCode(() =>
        makeRequest({ binding: { ...binding, controllerIncarnation: 7 as unknown as string } }),
      ),
    ).toBe("invalid_schema");
    expect(
      errorCode(() => makeRequest({ binding: { ...binding, producerIncarnation: "bad\0value" } })),
    ).toBe("invalid_schema");
  });

  it("rejects schema-extra and accessor input", () => {
    const extraEnvelope = clone(makeRequest()) as unknown as Record<string, unknown>;
    extraEnvelope.extra = true;
    expect(errorCode(() => verifyRequest(extraEnvelope))).toBe("invalid_schema");

    const extraBody = clone(makeRequest());
    (extraBody.body as unknown as Record<string, unknown>).extra = true;
    expect(errorCode(() => verifyRequest(extraBody))).toBe("invalid_schema");

    const extraBinding = clone(makeRequest());
    (extraBinding.body.binding as unknown as Record<string, unknown>).extra = true;
    expect(errorCode(() => verifyRequest(extraBinding))).toBe("invalid_schema");

    const accessor = clone(makeRequest());
    Object.defineProperty(accessor.body, "messageId", { enumerable: true, get: () => "x" });
    expect(errorCode(() => verifyRequest(accessor))).toBe("unsafe_object");

    const inherited = clone(makeRequest());
    const inheritedBody = Object.assign(Object.create({ inherited: true }), inherited.body);
    inherited.body = inheritedBody as ControlRequestBody;
    expect(errorCode(() => verifyRequest(inherited))).toBe("unsafe_object");
  });
});

describe("direction and bidirectional revocation", () => {
  it("supports producer-initiated revoke_submission and controller ACK", () => {
    const request = makeRequest(
      {
        keyId: "producer-key",
        direction: "producer_to_controller",
        operation: "revoke_submission",
        messageId: "msg-producer-revoke",
      },
      producerKeys.privateKey,
    );
    const verifiedRequest = verifyRequest(request, producerTrust, "producer_to_controller");
    const ackBody = makeAckBody(verifiedRequest.body, {
      keyId: "controller-key",
      direction: "controller_to_producer",
      phase: "revoked",
      facts: {
        projection: { admissionClosed: true, projectionApplied: true },
        revoked: { authorizationRevoked: true },
        stop: null,
      },
    });
    const verifiedAck = verifyAck(
      signAck(ackBody, controllerKeys.privateKey),
      controllerTrust,
      "controller_to_producer",
    );
    const evaluation = evaluateControlAck(verifiedRequest.body, verifiedAck.body);
    expect(evaluation.operation).toBe("revoke_submission");
    expect(evaluation.projection.complete).toBe(true);
    expect(evaluation.revoked.complete).toBe(true);
    expect(evaluation.stop).toBeNull();
  });

  it("supports controller-initiated revoke_submission", () => {
    const request = makeRequest({ operation: "revoke_submission" });
    const verifiedRequest = verifyRequest(request);
    const ack = signAck(makeAckBody(verifiedRequest.body));
    const evaluation = evaluateControlAck(verifiedRequest.body, verifyAck(ack).body);
    expect(evaluation.operation).toBe("revoke_submission");
    expect(evaluation.revoked.complete).toBe(true);
  });

  it("allows stop only from controller to producer", () => {
    expect(
      errorCode(() =>
        makeRequest(
          {
            keyId: "producer-key",
            direction: "producer_to_controller",
            operation: "stop",
          },
          producerKeys.privateKey,
        ),
      ),
    ).toBe("invalid_schema");
    expect(verifyRequest(makeRequest()).body.direction).toBe("controller_to_producer");
  });

  it("requires the ACK direction to be the reverse of the request", () => {
    const verifiedRequest = verifyRequest(makeRequest());
    const wrongDirection = clone(makeAckBody(verifiedRequest.body));
    wrongDirection.direction = "controller_to_producer";
    expect(errorCode(() => evaluateControlAck(verifiedRequest.body, wrongDirection))).toBe(
      "correlation_mismatch",
    );
  });
});

describe("ACK correlation and fact separation", () => {
  function makeValidStopPair() {
    const verifiedRequest = verifyRequest(makeRequest());
    const verifiedAck = verifyAck(signAck(makeAckBody(verifiedRequest.body)));
    return { verifiedRequest, verifiedAck };
  }

  it("correlates messageId, sequence, payloadDigest, lineage and revision", () => {
    const { verifiedRequest, verifiedAck } = makeValidStopPair();
    expect(evaluateControlAck(verifiedRequest.body, verifiedAck.body)).toEqual({
      operation: "stop",
      projection: { admissionClosed: true, projectionApplied: true, complete: true },
      revoked: { authorizationRevoked: true, complete: true },
      stop: {
        nativeFenced: true,
        pending: false,
        ownedInputsReleased: true,
        leaseReleased: true,
        complete: true,
        reasons: [],
      },
    });

    const tamperCases: Array<[string, (ack: ControlAckBody) => void]> = [
      ["replyToMessageId", (ack) => (ack.replyToMessageId = "msg-other")],
      ["replyToSequence", (ack) => (ack.replyToSequence = 2)],
      ["replyToPayloadDigest", (ack) => (ack.replyToPayloadDigest = "0".repeat(64))],
      ["submissionLineageId", (ack) => (ack.submissionLineageId = "lineage-other")],
      ["authorizationRevision", (ack) => (ack.authorizationRevision = 2)],
      ["binding.channelId", (ack) => (ack.binding.channelId = "channel-other")],
    ];
    for (const [name, mutate] of tamperCases) {
      const ack = clone(verifiedAck.body);
      mutate(ack);
      expect(
        errorCode(() => evaluateControlAck(verifiedRequest.body, ack)),
        name,
      ).toBe("correlation_mismatch");
    }
  });

  it("requires every stop fact and rejects missing stop facts", () => {
    const { verifiedRequest, verifiedAck } = makeValidStopPair();
    const stopFields = ["nativeFenced", "pending", "ownedInputsReleased", "leaseReleased"] as const;
    for (const field of stopFields) {
      const ack = clone(verifiedAck.body);
      const stop = ack.facts.stop as unknown as Record<string, boolean>;
      delete stop[field];
      expect(errorCode(() => evaluateControlAck(verifiedRequest.body, ack))).toBe("invalid_schema");
    }

    const missingStop = clone(verifiedAck.body);
    delete (missingStop.facts as unknown as Record<string, unknown>).stop;
    expect(errorCode(() => evaluateControlAck(verifiedRequest.body, missingStop))).toBe(
      "invalid_schema",
    );

    const nullStop = clone(verifiedAck.body);
    nullStop.facts.stop = null;
    expect(errorCode(() => evaluateControlAck(verifiedRequest.body, nullStop))).toBe(
      "invalid_schema",
    );

    const missingProjection = clone(verifiedAck.body);
    delete (missingProjection.facts.projection as unknown as Record<string, unknown>)
      .admissionClosed;
    expect(errorCode(() => evaluateControlAck(verifiedRequest.body, missingProjection))).toBe(
      "invalid_schema",
    );

    const extraStop = clone(verifiedAck.body);
    (extraStop.facts.stop as unknown as Record<string, unknown>).extra = true;
    expect(errorCode(() => evaluateControlAck(verifiedRequest.body, extraStop))).toBe(
      "invalid_schema",
    );
  });

  it("fails stop when any required condition is false", () => {
    const { verifiedRequest, verifiedAck } = makeValidStopPair();
    const cases: Array<[string, (ack: ControlAckBody) => void, string]> = [
      [
        "admissionClosed",
        (ack) => {
          ack.facts.projection.admissionClosed = false;
        },
        "admission_not_closed",
      ],
      [
        "projectionApplied",
        (ack) => {
          ack.facts.projection.projectionApplied = false;
        },
        "projection_not_applied",
      ],
      [
        "authorizationRevoked",
        (ack) => {
          ack.facts.revoked.authorizationRevoked = false;
        },
        "authorization_not_revoked",
      ],
      [
        "nativeFenced",
        (ack) => {
          if (ack.facts.stop) ack.facts.stop.nativeFenced = false;
        },
        "native_not_fenced",
      ],
      [
        "pending",
        (ack) => {
          if (ack.facts.stop) ack.facts.stop.pending = true;
        },
        "pending",
      ],
      [
        "ownedInputsReleased",
        (ack) => {
          if (ack.facts.stop) ack.facts.stop.ownedInputsReleased = false;
        },
        "owned_inputs_not_released",
      ],
      [
        "leaseReleased",
        (ack) => {
          if (ack.facts.stop) ack.facts.stop.leaseReleased = false;
        },
        "lease_not_released",
      ],
    ];
    for (const [name, mutate, reason] of cases) {
      const ack = clone(verifiedAck.body);
      mutate(ack);
      const evaluation = evaluateControlAck(verifiedRequest.body, ack);
      expect(evaluation.stop?.complete, name).toBe(false);
      expect(evaluation.stop?.reasons, name).toContain(reason);
    }
  });

  it.each(["unknown", "rejected", "retained_fault"] as const)(
    "does not let phase %s succeed",
    (phase) => {
      const verifiedRequest = verifyRequest(makeRequest());
      const ack = makeAckBody(verifiedRequest.body, { phase });
      const evaluation = evaluateControlAck(verifiedRequest.body, ack);
      expect(evaluation.projection.complete).toBe(false);
      expect(evaluation.revoked.complete).toBe(false);
      expect(evaluation.stop?.complete).toBe(false);
      expect(evaluation.stop?.reasons).toContain("phase_failure");
    },
  );

  it("requires a final stop phase", () => {
    const verifiedRequest = verifyRequest(makeRequest());
    const pending = evaluateControlAck(
      verifiedRequest.body,
      makeAckBody(verifiedRequest.body, { phase: "stop_pending" }),
    );
    expect(pending.stop?.complete).toBe(false);
    expect(pending.stop?.reasons).toContain("phase_not_final");

    for (const phase of ["fenced", "drained"] as const) {
      const evaluation = evaluateControlAck(
        verifiedRequest.body,
        makeAckBody(verifiedRequest.body, { phase }),
      );
      expect(evaluation.stop?.complete, phase).toBe(true);
    }
  });

  it("keeps revoke projection and revoked facts separate from stop", () => {
    const verifiedRequest = verifyRequest(makeRequest({ operation: "revoke_submission" }));
    const ack = makeAckBody(verifiedRequest.body, {
      phase: "revoked",
      facts: {
        projection: { admissionClosed: true, projectionApplied: true },
        revoked: { authorizationRevoked: true },
        stop: null,
      },
    });
    const evaluation = evaluateControlAck(verifiedRequest.body, ack);
    expect(evaluation.projection.complete).toBe(true);
    expect(evaluation.revoked.complete).toBe(true);
    expect(evaluation.stop).toBeNull();
  });
});

describe("bounded replay window", () => {
  it("advances exact+1 through the default 64-record window", () => {
    let state = createControlReplayWindow({
      windowSize: CONTROL_LIMITS.defaultReplayWindow,
      binding,
      direction: "controller_to_producer",
    });
    for (let sequence = 1; sequence <= 65; sequence += 1) {
      const result = admitControlSequence(
        state,
        makeReplayEntry(sequence, digestControlPayload({ sequence })),
      );
      expect(result.decision).toBe("exact");
      state = result.state;
    }
    expect(state.windowSize).toBe(64);
    expect(state.lastSequence).toBe(65);
    expect(state.records).toHaveLength(64);
    expect(state.records[0]?.sequence).toBe(2);
    expect(state.records.at(-1)?.sequence).toBe(65);
  });

  it("supports the 1024-record boundary independently of the generic array cap", () => {
    let state = createControlReplayWindow({
      windowSize: CONTROL_LIMITS.maxReplayWindow,
      binding,
      direction: "controller_to_producer",
    });
    for (let sequence = 1; sequence <= 1025; sequence += 1) {
      const result = admitControlSequence(
        state,
        makeReplayEntry(sequence, digestControlPayload({ sequence })),
      );
      expect(result.decision).toBe("exact");
      state = result.state;
    }
    expect(state.lastSequence).toBe(1025);
    expect(state.records).toHaveLength(1024);
    expect(state.records[0]?.sequence).toBe(2);
    expect(state.records.at(-1)?.sequence).toBe(1025);
  });

  it("classifies duplicate, conflict and stale without advancing", () => {
    let state = createControlReplayWindow({
      windowSize: 2,
      binding,
      direction: "controller_to_producer",
    });
    const firstDigest = digestControlPayload({ sequence: 1 });
    let result = admitControlSequence(state, makeReplayEntry(1, firstDigest));
    expect(result.decision).toBe("exact");
    state = result.state;

    result = admitControlSequence(state, makeReplayEntry(1, firstDigest));
    expect(result.decision).toBe("duplicate");
    expect(result.state).toEqual(state);

    result = admitControlSequence(state, makeReplayEntry(1, digestControlPayload({ sequence: 9 })));
    expect(result.decision).toBe("conflict");
    expect(result.state).toEqual(state);

    result = admitControlSequence(state, makeReplayEntry(1, firstDigest, { messageId: "other" }));
    expect(result.decision).toBe("conflict");

    result = admitControlSequence(state, makeReplayEntry(3, digestControlPayload({ sequence: 3 })));
    expect(result.decision).toBe("stale");

    result = admitControlSequence(state, makeReplayEntry(2, digestControlPayload({ sequence: 2 })));
    expect(result.decision).toBe("exact");
    state = result.state;
    result = admitControlSequence(state, makeReplayEntry(3, digestControlPayload({ sequence: 3 })));
    expect(result.decision).toBe("exact");
    state = result.state;
    result = admitControlSequence(state, makeReplayEntry(1, firstDigest));
    expect(result.decision).toBe("stale");
    expect(state.records.map((record) => record.sequence)).toEqual([2, 3]);
  });

  it("binds replay state to channel binding and direction", () => {
    const state = createControlReplayWindow({
      windowSize: 4,
      binding,
      direction: "controller_to_producer",
    });
    const digest = digestControlPayload({ sequence: 1 });
    expect(
      errorCode(() =>
        admitControlSequence(
          state,
          makeReplayEntry(1, digest, { binding: { ...binding, channelId: "channel-other" } }),
        ),
      ),
    ).toBe("channel_mismatch");
    expect(
      errorCode(() =>
        admitControlSequence(
          state,
          makeReplayEntry(1, digest, { direction: "producer_to_controller" }),
        ),
      ),
    ).toBe("channel_mismatch");
  });

  it("uses the full signed body digest, not only payloadDigest", () => {
    const first = verifyRequest(
      makeRequest({
        messageId: "replay-signed",
        sequence: 1,
        submissionLineageId: "lineage-a",
        authorizationRevision: 1,
      }),
    );
    const second = verifyRequest(
      makeRequest({
        messageId: "replay-signed",
        sequence: 1,
        submissionLineageId: "lineage-b",
        authorizationRevision: 1,
      }),
    );
    expect(first.body.payloadDigest).toBe(second.body.payloadDigest);
    expect(first.digest).not.toBe(second.digest);

    let state = createControlReplayWindow({
      windowSize: 4,
      binding,
      direction: "controller_to_producer",
    });
    let result = admitControlSequence(
      state,
      makeReplayEntry(1, first.digest, { messageId: "replay-signed" }),
    );
    expect(result.decision).toBe("exact");
    state = result.state;
    result = admitControlSequence(
      state,
      makeReplayEntry(1, second.digest, { messageId: "replay-signed" }),
    );
    expect(result.decision).toBe("conflict");
  });

  it("treats keyId-only and facts-only changes as conflicts", () => {
    const first = verifyControlEnvelope(
      makeRequest({ messageId: "key-change", sequence: 1 }, controllerKeys.privateKey),
      {
        trustedKeys: bothTrust,
        expectedKind: "request",
        expectedDirection: "controller_to_producer",
        expectedBinding: binding,
      },
    );
    const second = verifyControlEnvelope(
      makeRequest(
        { messageId: "key-change", sequence: 1, keyId: "other-key" },
        otherKeys.privateKey,
      ),
      {
        trustedKeys: bothTrust,
        expectedKind: "request",
        expectedDirection: "controller_to_producer",
        expectedBinding: binding,
      },
    );
    expect(first.digest).not.toBe(second.digest);

    let state = createControlReplayWindow({
      windowSize: 4,
      binding,
      direction: "controller_to_producer",
    });
    let result = admitControlSequence(
      state,
      makeReplayEntry(1, first.digest, { messageId: "key-change" }),
    );
    state = result.state;
    result = admitControlSequence(
      state,
      makeReplayEntry(1, second.digest, { messageId: "key-change" }),
    );
    expect(result.decision).toBe("conflict");

    const request = verifyRequest(makeRequest({ messageId: "facts-change" }));
    const ackA = verifyAck(signAck(makeAckBody(request.body)));
    const ackB = verifyAck(
      signAck(
        makeAckBody(request.body, {
          facts: {
            projection: { admissionClosed: true, projectionApplied: false },
            revoked: { authorizationRevoked: true },
            stop: null,
          },
        }),
      ),
    );
    expect(ackA.digest).not.toBe(ackB.digest);
    let ackState = createControlReplayWindow({
      windowSize: 4,
      binding,
      direction: "producer_to_controller",
    });
    result = admitControlSequence(
      ackState,
      makeReplayEntry(1, ackA.digest, { direction: "producer_to_controller" }),
    );
    ackState = result.state;
    result = admitControlSequence(
      ackState,
      makeReplayEntry(1, ackB.digest, { direction: "producer_to_controller" }),
    );
    expect(result.decision).toBe("conflict");
  });

  it("rejects out-of-range sequences, windows and forged state", () => {
    const state = createControlReplayWindow({
      windowSize: 4,
      binding,
      direction: "controller_to_producer",
    });
    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        errorCode(() =>
          admitControlSequence(
            state,
            makeReplayEntry(sequence, digestControlPayload({ sequence })),
          ),
        ),
      ).toBe("invalid_schema");
    }
    for (const windowSize of [0, 1025, 1.5]) {
      expect(
        errorCode(() =>
          createControlReplayWindow({ windowSize, binding, direction: "controller_to_producer" }),
        ),
      ).toBe("invalid_schema");
    }

    const forged = {
      windowSize: 1024,
      binding,
      direction: "controller_to_producer",
      lastSequence: 1025,
      records: Array.from({ length: 1025 }, (_, index) => ({
        sequence: index + 1,
        messageId: `forged-${index + 1}`,
        bodyDigest: digestControlPayload({ forged: index }),
      })),
    } as unknown as ControlReplayWindowState;
    expect(
      errorCode(() =>
        admitControlSequence(
          forged,
          makeReplayEntry(1026, digestControlPayload({ sequence: 1026 })),
        ),
      ),
    ).toBe("limit_exceeded");
  });
});

describe("monotonic revocation", () => {
  it("only transitions active to revoked", () => {
    const active = createControlRevocation({
      submissionLineageId: "lineage-1",
      authorizationRevision: 3,
    });
    expect(active.revoked).toBe(false);

    const applied = applyControlRevocation(active, {
      submissionLineageId: "lineage-1",
      authorizationRevision: 3,
    });
    expect(applied).toMatchObject({ applied: true, reason: "revoked" });
    expect(applied.state.revoked).toBe(true);

    const duplicate = applyControlRevocation(applied.state, {
      submissionLineageId: "lineage-1",
      authorizationRevision: 3,
    });
    expect(duplicate).toMatchObject({ applied: false, reason: "already_revoked" });
    expect(duplicate.state.revoked).toBe(true);

    const higher = applyControlRevocation(duplicate.state, {
      submissionLineageId: "lineage-1",
      authorizationRevision: 4,
    });
    expect(higher).toMatchObject({ applied: false, reason: "already_revoked" });
    expect(higher.state).toMatchObject({ revoked: true, authorizationRevision: 4 });

    const stale = applyControlRevocation(higher.state, {
      submissionLineageId: "lineage-1",
      authorizationRevision: 1,
    });
    expect(stale).toMatchObject({ applied: false, reason: "stale_revision" });
    expect(stale.state).toMatchObject({ revoked: true, authorizationRevision: 4 });
  });

  it("fails closed on lineage and revision errors", () => {
    const state = createControlRevocation({
      submissionLineageId: "lineage-1",
      authorizationRevision: 1,
    });
    expect(
      errorCode(() =>
        applyControlRevocation(state, {
          submissionLineageId: "lineage-2",
          authorizationRevision: 1,
        }),
      ),
    ).toBe("lineage_mismatch");
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        errorCode(() =>
          applyControlRevocation(state, {
            submissionLineageId: "lineage-1",
            authorizationRevision: revision,
          }),
        ),
      ).toBe("invalid_schema");
    }
  });
});

it("keeps the renamed broker predicate fail-closed through its runtime export", async () => {
  const broker = await import("@zody/zody-cua/broker/server");
  expect(broker.isPotentialZodyCuaAgentMcpServer({})).toBe(false);
});
