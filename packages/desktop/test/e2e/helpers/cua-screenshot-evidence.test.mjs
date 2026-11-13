import { strict as assert } from "node:assert";
import { test } from "node:test";
import { screenshotEvidence } from "./cua-screenshot-evidence.ts";
const png = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000200000003",
  "hex",
).toString("base64");
const request = (id, data = png) => ({
  messages: [
    {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data },
            },
          ],
        },
      ],
    },
  ],
});
test("summarizes only matching PNG tool result", () => {
  assert.deepEqual(screenshotEvidence(request("a"), "a"), {
    valid: true,
    width: 2,
    height: 3,
    imageCount: 1,
  });
  assert.equal(screenshotEvidence(request("a"), "b").valid, false);
  assert.equal(screenshotEvidence(request("a", "@@@@"), "a").valid, false);
  assert.equal(
    screenshotEvidence(request("a", Buffer.alloc(24).toString("base64")), "a")
      .valid,
    false,
  );
});
