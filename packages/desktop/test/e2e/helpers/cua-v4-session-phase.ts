import { sessionPhaseSchema, type SessionPhase } from "@zody/shared/zody-protocol-v4";

/** 将已选 pane 的原始属性严格校验；可供 WebDriver 和 Playwright 共用。 */
export function parseCuaV4SessionPhase(
  observed: { sessionId: string | null; phase: string | null } | null,
  expectedSessionId: string,
): SessionPhase | null {
  if (!observed || !expectedSessionId || observed.sessionId !== expectedSessionId) return null;
  const parsed = sessionPhaseSchema.safeParse(observed.phase);
  return parsed.success ? parsed.data : null;
}

/** 只读取指定 pane 的权威 V4 snapshot 投影，不推断缺省状态。 */
export async function readCuaV4SessionPhase(
  expectedSessionId: string,
): Promise<SessionPhase | null> {
  const observed = await browser.execute(() => {
    const pane = document.querySelector<HTMLElement>(
      '[data-testid="v4-session-pane-workspace-main"]',
    );
    return pane
      ? {
          sessionId: pane.getAttribute("data-session-id"),
          phase: pane.getAttribute("data-session-phase"),
        }
      : null;
  });
  return parseCuaV4SessionPhase(observed, expectedSessionId);
}
