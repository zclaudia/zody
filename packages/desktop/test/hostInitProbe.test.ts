import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { HostMessageTypes, HostResponseTypes } from "@zcode/shared";
import { probeNativeHostInitialization } from "../scripts/hostInitProbe.js";

class FakeProbeHost extends EventEmitter {
  readonly posted: Array<{ message: unknown; ports: unknown[] }> = [];
  killed = false;

  waitForHostId(): Promise<string> {
    return Promise.resolve("sealed-host-id");
  }

  postMessage(message: unknown, ports?: unknown[]): void {
    this.posted.push({ message, ports: ports ?? [] });
    if ((message as { type?: string }).type === HostMessageTypes.InitLocal) {
      queueMicrotask(() => {
        this.emit("message", {
          type: HostResponseTypes.DatabaseStartupState,
          state: {
            schemaVersion: 1,
            startupId: "startup",
            attemptId: "attempt",
            sequence: 1,
            startedAt: 1,
            updatedAt: 2,
            phase: "ready",
            disk: [],
          },
        });
      });
    } else if ((message as { type?: string }).type === HostMessageTypes.Dispose) {
      queueMicrotask(() => this.emit("exit", 0));
    }
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 1));
    return true;
  }
}

describe("native Host InitLocal probe", () => {
  it("sends the complete real InitLocal shape and only reports ready after DatabaseStartupState", async () => {
    const host = new FakeProbeHost();
    const states: string[] = [];
    const result = await probeNativeHostInitialization(
      {
        nativeHostLaunch: {
          launcherPath: "/opt/zody/native/zody-native",
          cwd: "/opt/zody/runtime",
        },
        workspacePath: "/workspace",
        workspaceIdentity: "identity",
        zcodeBuiltinProviderConfigFilePath: "/config/zcode-builtin.json",
        runtimeProcessEnvPatch: { SAFE_VALUE: "1" },
        onState: (state) => states.push(state.phase),
      },
      { spawnHost: () => host },
    );
    expect(result.hostId).toBe("sealed-host-id");
    expect(result.state.phase).toBe("ready");
    expect(states).toContain("ready");
    expect(host.posted[0]?.ports).toHaveLength(1);
    expect(host.posted[0]?.message).toMatchObject({
      type: HostMessageTypes.InitLocal,
      hostId: "sealed-host-id",
      workspacePath: "/workspace",
      workspaceIdentity: "identity",
      agentSpawnFallbackCwd: "/workspace",
      zcodeBuiltinProviderConfigFilePath: "/config/zcode-builtin.json",
      runtimeProcessEnvPatch: { SAFE_VALUE: "1" },
    });
    expect(host.posted.at(-1)?.message).toEqual({ type: HostMessageTypes.Dispose });
    expect(host.killed).toBe(false);
  });
});
