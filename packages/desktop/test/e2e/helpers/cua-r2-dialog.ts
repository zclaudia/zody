import { parseR1IdentityRows } from "./cua-r1-receipt.js";
/** 对同一 DOM 快照的精确字段解析；数字子串不能充当 PID/window ID 证明。 */
export async function readR2PermissionCards() {
  const cards = await browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-cua-confirm-kind]"))
      .filter((card) => card.getClientRects().length > 0)
      .map((card) => ({
        kind: card.getAttribute("data-cua-confirm-kind"),
        requestId: card.getAttribute("data-permission-request-id"),
        rows: Array.from(
          card.querySelectorAll('[data-cua-screenshot-confirm-target="true"] dl dt'),
        ).map(
          (dt) =>
            [(dt.textContent ?? "").trim(), (dt.nextElementSibling?.textContent ?? "").trim()] as [
              string,
              string,
            ],
        ),
        defaultReject:
          card
            .querySelector('[data-permission-option-kind="rejectOnce"]')
            ?.getAttribute("aria-selected") === "true",
        forbidden: !!card.querySelector(
          '[data-permission-option-kind="allowAlways"],[data-permission-option-kind="fullAccess"]',
        ),
      })),
  );
  return cards.map(({ rows, ...card }) => ({ ...card, identity: parseR1IdentityRows(rows) }));
}
/** DOM 激活真实确认控件；不激活后台 Electron 窗口或注入 authority 结果。 */
export async function answerR2Permission(
  kind: "read" | "control",
  allow: boolean,
  requestId: string,
) {
  const selector = `[data-cua-confirm-kind="${kind}"][data-permission-request-id="${requestId}"]`;
  const option = allow ? "allowOnce" : "rejectOnce";
  await browser.waitUntil(
    async () => {
      const outcome = await browser.execute(
        (cardSelector, optionKind) => {
          const card = document.querySelector<HTMLElement>(cardSelector);
          const button = card?.querySelector<HTMLButtonElement>(
            `[data-permission-option-kind="${optionKind}"]`,
          );
          if (!card || !button || button.disabled || !card.getClientRects().length)
            return "missing";
          const selected = button.getAttribute("aria-selected") === "true";
          button.click();
          return selected ? "confirmed" : "selected";
        },
        selector,
        option,
      );
      if (outcome === "missing")
        throw new Error("R2 exact visible card disappeared before decision");
      return outcome === "confirmed";
    },
    { timeout: 10_000, interval: 30 },
  );
  await browser.waitUntil(
    () => browser.execute((cardSelector) => !document.querySelector(cardSelector), selector),
    { timeout: 10_000 },
  );
}
export async function allowR2NodePermission() {
  return browser.execute(() => {
    const lists = Array.from(document.querySelectorAll('[role="listbox"]')).filter((el) =>
      ["Permission required", "需要权限"].includes(el.getAttribute("aria-label") ?? ""),
    );
    if (lists.length !== 1 || lists[0]!.closest("[data-cua-confirm-kind]")) return false;
    const card = lists[0]!.parentElement?.parentElement?.parentElement;
    // 截图卡没有 read/control kind，也不是通用 node 确认，不能借父工具名混入。
    if (card?.querySelector('[data-cua-screenshot-confirm-target="true"]')) return false;
    if (!/mcp__node_repl__js/i.test(card?.textContent ?? "")) return false;
    const button = lists[0]!.querySelector<HTMLButtonElement>(
      '[role="option"][data-permission-option-kind="allowOnce"]',
    );
    if (!button || button.disabled) return false;
    button.click();
    return true;
  });
}
