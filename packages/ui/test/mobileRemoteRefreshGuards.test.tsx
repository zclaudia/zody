// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  getMobileRemoteRefreshGuardRegistry,
  installMobileRemoteRefreshGuardRegistry,
  resolveComposerDraftBlockReason,
  resolvePendingOptimisticOverlayBlockReason,
  resolveUnsavedSettingsBlockReason,
  useMobileRemoteRefreshGuard,
  type MobileRemoteRefreshGuard,
  type MobileRemoteRefreshGuardReason,
} from "../src/mobileRemoteRefreshGuards.js";

interface TestRegistry {
  guards: MobileRemoteRefreshGuard[];
  register(guard: MobileRemoteRefreshGuard): () => void;
  reasons(): MobileRemoteRefreshGuardReason[];
}

function createTestRegistry(): TestRegistry {
  const guards: MobileRemoteRefreshGuard[] = [];
  return {
    guards,
    register(guard) {
      guards.push(guard);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const index = guards.indexOf(guard);
        if (index >= 0) guards.splice(index, 1);
      };
    },
    reasons() {
      const values: MobileRemoteRefreshGuardReason[] = [];
      for (const guard of guards) {
        const reason = guard.getBlockReason();
        if (reason && !values.includes(reason)) values.push(reason);
      }
      return values;
    },
  };
}

function Probe({
  id = "probe",
  reason,
}: {
  id?: string;
  reason: MobileRemoteRefreshGuardReason | null;
}) {
  useMobileRemoteRefreshGuard(id, () => reason);
  return null;
}

afterEach(() => {
  cleanup();
  installMobileRemoteRefreshGuardRegistry(undefined);
});

describe("mobile remote refresh guard bridge", () => {
  it("does not install a registry by default (desktop/ordinary Web)", () => {
    expect(getMobileRemoteRefreshGuardRegistry()).toBeUndefined();
    const view = render(<Probe reason="composer-draft" />);
    expect(view.container.childElementCount).toBe(0);
    expect(getMobileRemoteRefreshGuardRegistry()).toBeUndefined();
  });

  it("registers guards that mount before the controller installs", () => {
    render(<Probe reason="composer-draft" />);
    const registry = createTestRegistry();
    act(() => {
      installMobileRemoteRefreshGuardRegistry(registry);
    });
    expect(registry.reasons()).toEqual(["composer-draft"]);
  });

  it("tracks live state and releases the guard when the blocker clears", () => {
    const registry = createTestRegistry();
    installMobileRemoteRefreshGuardRegistry(registry);
    const view = render(<Probe reason="composer-draft" />);
    expect(registry.reasons()).toEqual(["composer-draft"]);

    view.rerender(<Probe reason={null} />);
    expect(registry.reasons()).toEqual([]);

    view.rerender(<Probe reason="unsaved-settings" />);
    expect(registry.reasons()).toEqual(["unsaved-settings"]);
  });

  it("uses the latest callback instead of a stale closure", () => {
    const registry = createTestRegistry();
    installMobileRemoteRefreshGuardRegistry(registry);
    let current: MobileRemoteRefreshGuardReason | null = "composer-draft";

    function StaleProbe() {
      // 每帧传入新闭包；hook 必须通过 ref 读取最新回调，不能保留首帧的过期结果。
      const snapshot = current;
      useMobileRemoteRefreshGuard("stale-probe", () => snapshot);
      return null;
    }

    const view = render(<StaleProbe />);
    expect(registry.reasons()).toEqual(["composer-draft"]);
    current = null;
    view.rerender(<StaleProbe />);
    expect(registry.reasons()).toEqual([]);
  });

  it("supports multiple roots and duplicate ids with independent releases", () => {
    const registry = createTestRegistry();
    installMobileRemoteRefreshGuardRegistry(registry);
    const first = render(<Probe id="composer" reason="composer-draft" />);
    const second = render(<Probe id="composer" reason="composer-draft" />);
    const overlay = render(<Probe id="overlay" reason="active-overlay" />);
    expect(registry.guards).toHaveLength(3);

    first.unmount();
    expect(registry.reasons()).toEqual(["composer-draft", "active-overlay"]);
    second.unmount();
    expect(registry.reasons()).toEqual(["active-overlay"]);
    overlay.unmount();
    expect(registry.reasons()).toEqual([]);
  });

  it("releases mounted guards when the registry is uninstalled and re-registers on reinstall", () => {
    const registry = createTestRegistry();
    const uninstall = installMobileRemoteRefreshGuardRegistry(registry);
    render(<Probe reason="file-operation" />);
    expect(registry.reasons()).toEqual(["file-operation"]);

    act(() => {
      uninstall();
    });
    expect(getMobileRemoteRefreshGuardRegistry()).toBeUndefined();
    expect(registry.reasons()).toEqual([]);

    const next = createTestRegistry();
    act(() => {
      installMobileRemoteRefreshGuardRegistry(next);
    });
    expect(next.reasons()).toEqual(["file-operation"]);
  });
});

describe("pure refresh guard helpers", () => {
  it("blocks on unsent composer text or attachments only", () => {
    expect(resolveComposerDraftBlockReason({ text: "", hasAttachments: false })).toBeNull();
    expect(resolveComposerDraftBlockReason({ text: "   ", hasAttachments: false })).toBeNull();
    expect(resolveComposerDraftBlockReason({ text: "hello", hasAttachments: false })).toBe(
      "composer-draft",
    );
    expect(resolveComposerDraftBlockReason({ text: "", hasAttachments: true })).toBe(
      "composer-draft",
    );
  });

  it("blocks unsaved connection settings and releases after reset values", () => {
    expect(
      resolveUnsavedSettingsBlockReason({
        current: { gatewayUrl: "https://gateway.test", namespace: "zcode", credential: "" },
        initial: {
          gatewayUrl: "https://gateway.test",
          namespace: "zcode",
          credentialConfigured: true,
        },
      }),
    ).toBeNull();
    expect(
      resolveUnsavedSettingsBlockReason({
        current: { gatewayUrl: "https://other.test", namespace: "zcode", credential: "" },
        initial: {
          gatewayUrl: "https://gateway.test",
          namespace: "zcode",
          credentialConfigured: true,
        },
      }),
    ).toBe("unsaved-settings");
    expect(
      resolveUnsavedSettingsBlockReason({
        current: { gatewayUrl: "https://gateway.test", namespace: "zcode", credential: "zgd_new" },
        initial: {
          gatewayUrl: "https://gateway.test",
          namespace: "zcode",
          credentialConfigured: true,
        },
      }),
    ).toBe("unsaved-settings");
  });

  it("blocks while any workspace has an unconsumed optimistic overlay", () => {
    expect(resolvePendingOptimisticOverlayBlockReason({})).toBeNull();
    expect(
      resolvePendingOptimisticOverlayBlockReason({
        workspace: { optimisticTaskListByTaskId: {} },
      }),
    ).toBeNull();
    expect(
      resolvePendingOptimisticOverlayBlockReason({
        workspace: { optimisticTaskListByTaskId: { task: {} } },
      }),
    ).toBe("pending-optimistic-overlay");
  });
});
