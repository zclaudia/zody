import { describe, expect, it } from "vitest";
import { backgroundBashOutputTitle } from "../src/lib/backgroundBashOutputTitle.js";

describe("backgroundBashOutputTitle", () => {
  it("keeps the toolCall segment so parallel Bash outputs stay distinguishable", () => {
    expect(backgroundBashOutputTitle("/root/session/call-a/stdout.log")).toBe("call-a/stdout.log");
    expect(backgroundBashOutputTitle("C:\\root\\session\\call-b\\stdout.log")).toBe(
      "call-b/stdout.log",
    );
    expect(backgroundBashOutputTitle("stdout.log")).toBe("stdout.log");
    expect(backgroundBashOutputTitle("")).toBe("");
  });
});
