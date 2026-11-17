import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  r2PngDigest,
  r2CaptureAuditFromLog,
} from "./cua-r2-capture-evidence.ts";
const bytes = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000200000003",
  "hex",
);
const request = {
  messages: [
    {
      content: [
        {
          type: "tool_result",
          tool_use_id: "call",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: bytes.toString("base64"),
              },
            },
          ],
        },
      ],
    },
  ],
};
test("extracts digest only for the precise real PNG tool result", () => {
  const out = r2PngDigest(request, "call");
  assert.equal(out?.bytes, 24);
  assert.equal(out?.width, 2);
  assert.equal(out?.height, 3);
  assert.match(out.sha256, /^[a-f0-9]{64}$/);
  assert.equal(r2PngDigest(request, "other"), null);
});
test("accepts only a strict actual borrow capture audit", () => {
  const event = {
    sha256: "a".repeat(64),
    width: 2,
    height: 3,
    bytes: 24,
    resourcesReleased: true,
    machineLeaseReleased: false,
    machineLeaseBorrowReturned: true,
  };
  const line = (x) =>
    `CUA native audit [cua-native] capture-delivered ${JSON.stringify(x)}`;
  assert.equal(r2CaptureAuditFromLog(line(event)).length, 1);
  const { machineLeaseBorrowReturned: _borrowReturned, ...base } = event;
  assert.equal(
    r2CaptureAuditFromLog(line({ ...base, machineLeaseReleased: true }))[0]
      .machineLeaseReleased,
    true,
  );
  assert.equal(
    r2CaptureAuditFromLog(line({ ...event, machineLeaseReleased: true }))
      .length,
    0,
  );
  assert.equal(
    r2CaptureAuditFromLog(line({ ...event, unexpected: "x" })).length,
    0,
  );
});
test("retains only fixed native rejection facts", async () => {
  const { r2CaptureRejectionsFromLog } =
    await import("./cua-r2-capture-evidence.ts");
  const prefix = "CUA native audit [cua-native] capture-rejected ";
  assert.deepEqual(
    r2CaptureRejectionsFromLog(prefix + '{"reason":"tcc-not-authorized"}'),
    [{ reason: "tcc-not-authorized" }],
  );
  assert.deepEqual(
    r2CaptureRejectionsFromLog(
      prefix + '{"reason":"tcc-not-authorized","body":"secret"}',
    ),
    [],
  );
});
