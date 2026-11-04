import { describe, expect, it } from "vitest";
import {
  buildWorkspaceHookBundleSnapshot,
  createWorkspaceHookDeclarationDigest,
} from "../src/workspace-hook-digest.js";
import {
  workspaceHookCommandConfigSchema,
  workspaceHooksConfigSchema,
  type WorkspaceHookDefinition,
  type WorkspaceHookSourceInput,
} from "../src/workspace-hook-config.js";

/**
 * F10（上游 a60ba6a7）：workspace hook 声明的 `onError: "deny"` 必须进声明摘要——
 * 加上或去掉都要重新信任；不写或写 `"allow"` 时摘要与引入该字段之前逐字节相同，
 * 已有信任不失效（所以不需要提升 digest schema version）。
 */

function commandHook(extra: Record<string, unknown> = {}): WorkspaceHookDefinition {
  return workspaceHookCommandConfigSchema.parse({
    type: "command",
    command: "node guard.mjs",
    ...extra,
  });
}

function digestInput(hook: WorkspaceHookDefinition) {
  return {
    sourceRelativePath: ".zcode/config.json",
    sourceDiscoveryOrder: 0,
    event: "PreToolUse" as const,
    matcher: "CreateWorkflow",
    matcherIndex: 0,
    hookIndex: 0,
    hook,
    defaultTimeoutMs: 60_000,
    resolvedMaxOutputBytes: 32_768,
  };
}

function sourcesFor(onError: string | undefined): WorkspaceHookSourceInput[] {
  return [
    {
      canonicalPath: "/workspace/.zcode/config.json",
      baseDir: "/workspace",
      discoveryOrder: 0,
      configFileKind: ".zcode/config.json",
      explicitProjectConfig: false,
      editable: true,
      hooks: workspaceHooksConfigSchema.parse({
        enabled: true,
        events: {
          PreToolUse: [
            {
              matcher: "CreateWorkflow",
              hooks: [
                {
                  type: "command",
                  command: "node guard.mjs",
                  ...(onError === undefined ? {} : { onError }),
                },
              ],
            },
          ],
        },
      }),
    },
  ];
}

function snapshotFor(onError: string | undefined) {
  return buildWorkspaceHookBundleSnapshot({
    workspaceIdentity: "local:/workspace",
    workspacePath: "/workspace",
    sources: sourcesFor(onError),
    runtimeRoot: { enabled: true, timeoutMs: 60_000, maxOutputBytes: 32_768 },
    discoveredAt: "2026-11-02T00:00:00.000Z",
  });
}

describe("workspace hook declaration digest onError（F10，上游 a60ba6a7）", () => {
  it("onError deny 改变声明摘要：偏离声明后旧 Trust 不命中，需要重新信任", () => {
    const without = createWorkspaceHookDeclarationDigest(digestInput(commandHook()));
    const withDeny = createWorkspaceHookDeclarationDigest(
      digestInput(commandHook({ onError: "deny" })),
    );

    expect(withDeny).not.toBe(without);

    // 去掉 deny 回到原摘要；反过来重新加上 deny 又得到 deny 摘要——两个方向都需要重新信任。
    const denyAgain = createWorkspaceHookDeclarationDigest(
      digestInput(commandHook({ onError: "deny" })),
    );
    expect(denyAgain).toBe(withDeny);
  });

  it("不写或写 allow 的声明摘要逐字节相同，已有信任不失效", () => {
    const absent = createWorkspaceHookDeclarationDigest(digestInput(commandHook()));
    const allow = createWorkspaceHookDeclarationDigest(
      digestInput(commandHook({ onError: "allow" })),
    );

    expect(allow).toBe(absent);
  });

  it("快照条目只在声明为 deny 时携带 onError，且 declaration/bundle digest 随之变化", () => {
    const snapshotWithout = snapshotFor(undefined);
    const snapshotAllow = snapshotFor("allow");
    const snapshotDeny = snapshotFor("deny");

    expect(snapshotWithout).toBeDefined();
    expect(snapshotAllow).toBeDefined();
    expect(snapshotDeny).toBeDefined();
    expect(snapshotWithout!.hooks[0]!.onError).toBeUndefined();
    expect(snapshotAllow!.hooks[0]!.onError).toBeUndefined();
    expect(snapshotDeny!.hooks[0]!.onError).toBe("deny");
    expect(snapshotDeny!.hooks[0]!.hookDeclarationDigest).not.toBe(
      snapshotWithout!.hooks[0]!.hookDeclarationDigest,
    );
    expect(snapshotAllow!.hooks[0]!.hookDeclarationDigest).toBe(
      snapshotWithout!.hooks[0]!.hookDeclarationDigest,
    );
    expect(snapshotDeny!.bundleDigest).not.toBe(snapshotWithout!.bundleDigest);
    expect(snapshotAllow!.bundleDigest).toBe(snapshotWithout!.bundleDigest);
  });

  it("onError 只接受 allow/deny，其他值在声明解析时被拒绝", () => {
    expect(() =>
      workspaceHookCommandConfigSchema.parse({
        type: "command",
        command: "node guard.mjs",
        onError: "block",
      }),
    ).toThrow();
    expect(() =>
      workspaceHooksConfigSchema.parse({
        events: {
          PreToolUse: [{ hooks: [{ type: "command", command: "x", onError: 1 }] }],
        },
      }),
    ).toThrow();
  });
});
