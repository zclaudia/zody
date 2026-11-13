import type { UpstreamToolResultSnapshot } from "./conversation-session-network.js";
import { listToolCallBlocks } from "./conversation-session-tool.js";
import { clickR1AllowOnce, readR1PermissionDialog } from "./cua-r1-dialog.js";
import { inspectStateToolResult, r1IdentityMatches, type R1Fixture } from "./cua-r1-receipt.js";

/** 单一用户 turn 中各次工具结果先到 provider，再进入下一次读取。 */
export async function runR1StateCells(input: {
  fixture: R1Fixture;
  latestResult: (id: string) => UpstreamToolResultSnapshot | null;
  onCall: (id: string) => void;
  onReadSeen: () => void;
  onReadAllowed: () => void;
}) {
  const calls = new Set<string>();
  const confirmations = new Set<string>();
  for (let stage = 1; stage <= 5; stage += 1) {
    let callId = "";
    await browser.waitUntil(
      async () => {
        const block = (await listToolCallBlocks()).find(
          (item) =>
            item.toolName === "mcp__node_repl__js" &&
            item.toolCallId &&
            !calls.has(item.toolCallId),
        );
        callId = block?.toolCallId ?? "";
        return Boolean(callId);
      },
      { timeout: 60_000, timeoutMsg: `R1 stage ${stage}: new node_repl call missing` },
    );
    calls.add(callId);
    input.onCall(callId);
    let nodeClicked = false;
    let failure = "";
    let requestId = "";
    await browser.waitUntil(
      async () => {
        const dialog = await readR1PermissionDialog();
        if (dialog.kind === "node" && !nodeClicked) {
          try {
            await clickR1AllowOnce("node");
            nodeClicked = true;
          } catch {
            failure = `R1 stage ${stage}: node permission failed`;
            return true;
          }
        }
        if (dialog.kind === "read" && dialog.requestId && !confirmations.has(dialog.requestId)) {
          requestId = dialog.requestId;
          input.onReadSeen();
          if (
            !/Read window content|读取窗口内容/.test(dialog.text) ||
            !r1IdentityMatches(dialog.identity, input.fixture.pid, input.fixture.targetWindow) ||
            dialog.allowAlways ||
            dialog.fullAccess
          )
            failure = `R1 stage ${stage}: invalid read confirmation`;
          return true;
        }
        const result = input.latestResult(callId);
        if (result) {
          failure = `R1 stage ${stage}: read confirmation absent`;
          return true;
        }
        return false;
      },
      { timeout: 60_000, timeoutMsg: `R1 stage ${stage}: read confirmation missing` },
    );
    if (failure) throw new Error(failure);
    if (!requestId || confirmations.has(requestId))
      throw new Error(`R1 stage ${stage}: repeated read confirmation`);
    confirmations.add(requestId);
    await clickR1AllowOnce("read", requestId);
    input.onReadAllowed();
    let result: UpstreamToolResultSnapshot | null = null;
    await browser.waitUntil(
      () => {
        result = input.latestResult(callId);
        return Boolean(result);
      },
      { timeout: 60_000, timeoutMsg: `R1 stage ${stage}: actual provider tool_result missing` },
    );
    const receipt = inspectStateToolResult(result, input.fixture, stage);
    if (!receipt.ok)
      throw new Error(`R1 stage ${stage}: invalid actual tool_result ${JSON.stringify(receipt)}`);
  }
  if (calls.size !== 5 || confirmations.size !== 5)
    throw new Error("R1 state observations were not distinct");
}
