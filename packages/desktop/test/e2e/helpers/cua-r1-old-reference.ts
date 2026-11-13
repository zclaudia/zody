import type { UpstreamToolResultSnapshot } from "./conversation-session-network.js";

export async function waitR1OldReferenceResult(input: {
  callId: string;
  seenReads: ReadonlySet<string>;
  readDialog: () => Promise<{ kind: "node" | "read" | "other" | "none"; requestId: string | null }>;
  allowNode: () => Promise<void>;
  latestResult: (id: string) => UpstreamToolResultSnapshot | null;
}) {
  let observed: UpstreamToolResultSnapshot | null = null;
  let unexpectedRead = false;
  let nodeClicked = false;
  let admissionFailed = false;
  await browser.waitUntil(
    async () => {
      const d = await input.readDialog();
      if (d.kind === "read" && (!d.requestId || !input.seenReads.has(d.requestId))) {
        unexpectedRead = true;
        return true;
      }
      // 旧引用应在正文确认前拒绝，但 cell 自身仍需通用工具许可；漏处理会把等待许可误报成读取超时。
      if (d.kind === "node" && !nodeClicked) {
        nodeClicked = true;
        try {
          await input.allowNode();
        } catch {
          admissionFailed = true;
          return true;
        }
      }
      observed = input.latestResult(input.callId);
      return Boolean(observed);
    },
    { timeout: 60_000, timeoutMsg: "R1 old window result missing" },
  );
  if (admissionFailed) throw new Error("R1 old window node permission failed");
  return { result: observed, unexpectedRead };
}
