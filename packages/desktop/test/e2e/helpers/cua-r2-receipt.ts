export interface R2BusinessSnapshot {
  fixtureKind: "controlled-ax-write-v1";
  pid: number;
  targetWindow: number;
  siblingWindow: number;
  target: { presses: number; requests: number; value: string; ignoreEffects: boolean };
  sibling: { presses: number; requests: number; value: string; ignoreEffects: boolean };
}
export interface R2WriteReceipt {
  action_sent: boolean;
  dispatch_status: "not_sent" | "sent" | "possibly_sent";
  state_sync_status: "not_requested" | "synced" | "failed";
  code?: string;
}

/** node_repl 聚合子工具的 isError；预期拒绝只作为零派发负例，不是动作成功。 */
export function readR2TrialReceipt(
  result: { content: string; isError: boolean },
  kind: "deny" | "left_click" | "perform_action" | "set_value",
  trial: number,
): R2WriteReceipt {
  const match = result.content.match(/R2_RECEIPTS:(\{[^\n]*\})/);
  if (!match) throw new Error("R2 actual SDK receipt missing");
  const parsed = JSON.parse(match[1]!) as { kind?: unknown; trial?: unknown; receipts?: unknown };
  if (
    parsed.kind !== kind ||
    parsed.trial !== trial ||
    !Array.isArray(parsed.receipts) ||
    parsed.receipts.length !== 1
  )
    throw new Error("R2 receipt association mismatch");
  const receipt = parsed.receipts[0] as R2WriteReceipt;
  if (
    !receipt ||
    typeof receipt.action_sent !== "boolean" ||
    !["not_sent", "sent", "possibly_sent"].includes(receipt.dispatch_status) ||
    !["not_requested", "synced", "failed"].includes(receipt.state_sync_status)
  )
    throw new Error("R2 receipt invalid");
  if (kind === "deny") {
    if (
      receipt.code !== "permission_denied" ||
      receipt.action_sent !== false ||
      receipt.dispatch_status !== "not_sent" ||
      receipt.state_sync_status !== "not_requested"
    )
      throw new Error("R2 expected typed zero-dispatch denial missing");
  } else if (
    result.isError ||
    receipt.code ||
    !receipt.action_sent ||
    receipt.dispatch_status !== "sent"
  ) {
    throw new Error(`R2 action was not proven: ${receipt.code ?? receipt.dispatch_status}`);
  }
  return receipt;
}

/** 必须以独立业务模型证明效果；AX 成功与安全拒绝都不能充当成功试次。 */
export function inspectR2Effect(input: {
  before: R2BusinessSnapshot;
  after: R2BusinessSnapshot;
  method: "left_click" | "perform_action" | "set_value";
  receipts: R2WriteReceipt[];
  count: number;
  value?: string;
}) {
  const { before, after, method, receipts, count, value } = input;
  const sameIdentity =
    before.fixtureKind === "controlled-ax-write-v1" &&
    after.fixtureKind === before.fixtureKind &&
    before.pid === after.pid &&
    before.targetWindow === after.targetWindow &&
    before.siblingWindow === after.siblingWindow &&
    before.targetWindow !== before.siblingWindow;
  const siblingUnchanged = JSON.stringify(before.sibling) === JSON.stringify(after.sibling);
  const receiptsProven =
    Number.isSafeInteger(count) &&
    count > 0 &&
    receipts.length === count &&
    receipts.every(
      (r) =>
        r.action_sent === true &&
        r.dispatch_status === "sent" &&
        !r.code &&
        (r.state_sync_status === "not_requested" || r.state_sync_status === "synced"),
    );
  const businessEffect =
    !before.target.ignoreEffects &&
    !after.target.ignoreEffects &&
    after.target.requests - before.target.requests === count &&
    (method === "set_value"
      ? typeof value === "string" &&
        after.target.value === value &&
        after.target.presses === before.target.presses
      : after.target.presses - before.target.presses === count &&
        after.target.value === before.target.value);
  return {
    ok: sameIdentity && siblingUnchanged && receiptsProven && businessEffect,
    sameIdentity,
    siblingUnchanged,
    receiptsProven,
    businessEffect,
  };
}

/** 错误码不能证明人审拒绝；必须保留精确窗口上的真实 control 决策。 */
export function inspectR2Denial(input: {
  before: R2BusinessSnapshot;
  after: R2BusinessSnapshot;
  controlRejected: boolean;
  receipt: R2WriteReceipt;
}): boolean {
  const { before, after, receipt } = input;
  return (
    input.controlRejected &&
    before.fixtureKind === after.fixtureKind &&
    before.pid === after.pid &&
    before.targetWindow === after.targetWindow &&
    before.siblingWindow === after.siblingWindow &&
    before.targetWindow !== before.siblingWindow &&
    JSON.stringify(before.target) === JSON.stringify(after.target) &&
    JSON.stringify(before.sibling) === JSON.stringify(after.sibling) &&
    receipt.code === "permission_denied" &&
    receipt.action_sent === false &&
    receipt.dispatch_status === "not_sent" &&
    receipt.state_sync_status === "not_requested"
  );
}
