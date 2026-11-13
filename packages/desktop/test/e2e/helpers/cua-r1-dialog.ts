import { parseR1IdentityRows } from "./cua-r1-receipt.js";

/** 通过当前确认卡上的协议工具名区分请求；不读取其他 UI 或用户正文。 */
export async function readR1PermissionDialog(): Promise<{
  kind: "node" | "read" | "other" | "none";
  text: string;
  allowAlways: boolean;
  fullAccess: boolean;
  requestId: string | null;
  identity: { pid: number; windowId: number } | null;
}> {
  const result = await browser.execute(() => {
    const lists = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).filter(
      (element) =>
        ["Permission required", "需要权限"].includes(element.getAttribute("aria-label") ?? ""),
    );
    if (lists.length !== 1)
      return {
        kind: "none" as const,
        text: "",
        allowAlways: false,
        fullAccess: false,
        requestId: null,
        rows: [] as Array<[string, string]>,
      };
    const card = lists[0]?.parentElement?.parentElement?.parentElement;
    const text = card?.textContent ?? "";
    const kind = lists[0]?.closest('[data-cua-confirm-kind="read"]')
      ? ("read" as const)
      : /mcp__node_repl__js/i.test(text)
        ? ("node" as const)
        : ("other" as const);
    const readCard = lists[0]?.closest('[data-cua-confirm-kind="read"]');
    const rows = Array.from(
      readCard?.querySelectorAll('[data-cua-screenshot-confirm-target="true"] dl dt') ?? [],
    ).map((dt): [string, string] => {
      const dd = dt.nextElementSibling;
      return [
        (dt.textContent ?? "").trim(),
        dd?.tagName === "DD" ? (dd.textContent ?? "").trim() : "",
      ];
    });
    return {
      kind,
      rows,
      requestId:
        lists[0]
          ?.closest('[data-cua-confirm-kind="read"]')
          ?.getAttribute("data-permission-request-id") ?? null,
      text,
      allowAlways: Boolean(lists[0]?.querySelector('[data-permission-option-kind="allowAlways"]')),
      fullAccess: Boolean(lists[0]?.querySelector('[data-permission-option-kind="fullAccess"]')),
    };
  });
  const { rows, ...dialog } = result;
  return { ...dialog, identity: parseR1IdentityRows(rows) };
}

export async function clickR1AllowOnce(expected: "node" | "read", requestId?: string) {
  // 读取卡默认拒绝：先显式选择 allow，再次核验同一类卡并确认。
  const click = async (confirm: boolean) =>
    browser.execute(
      (kind, shouldConfirm, expectedId) => {
        const lists = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).filter(
          (element) =>
            ["Permission required", "需要权限"].includes(element.getAttribute("aria-label") ?? ""),
        );
        if (lists.length !== 1) return false;
        if (
          kind === "read" &&
          expectedId &&
          lists[0]
            ?.closest('[data-cua-confirm-kind="read"]')
            ?.getAttribute("data-permission-request-id") !== expectedId
        )
          return false;
        const text = lists[0]?.parentElement?.parentElement?.parentElement?.textContent ?? "";
        if (
          !(kind === "read"
            ? Boolean(lists[0]?.closest('[data-cua-confirm-kind="read"]'))
            : /mcp__node_repl__js/i.test(text))
        )
          return false;
        const button = lists[0]?.querySelector<HTMLButtonElement>(
          '[role="option"][data-permission-option-kind="allowOnce"]',
        );
        if (!button) return false;
        const selected = button.getAttribute("aria-selected") === "true";
        if (shouldConfirm !== selected) return false;
        button.click();
        return true;
      },
      expected,
      confirm,
      requestId,
    );
  if (expected === "read") {
    expect(await click(false)).toBe(true);
    await browser.waitUntil(
      () =>
        browser.execute((expectedId) => {
          const lists = document.querySelectorAll(
            '[data-cua-confirm-kind="read"] [role="listbox"]',
          );
          return (
            lists.length === 1 &&
            (!expectedId ||
              lists[0]
                ?.closest('[data-cua-confirm-kind="read"]')
                ?.getAttribute("data-permission-request-id") === expectedId) &&
            lists[0]
              ?.querySelector('[data-permission-option-kind="allowOnce"]')
              ?.getAttribute("aria-selected") === "true"
          );
        }, requestId),
      { timeout: 10_000, timeoutMsg: "Read allow option did not become selected" },
    );
  }
  expect(await click(true)).toBe(true);
}
