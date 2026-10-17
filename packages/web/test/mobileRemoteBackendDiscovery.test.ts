import { describe, expect, it, vi } from "vitest";
import type { BackendPresenceV4 } from "@zclaudia/gateway-protocol";
import { WEB_REMOTE_CONTROL_BACKEND_CAPABILITY } from "@zcode/shared";
import {
  startMobileRemoteBackendDiscovery,
  type MobileRemoteBackendDiscoverySnapshot,
  type MobileRemoteDiscoveryClientLike,
} from "../src/mobile-remote/mobileRemoteBackendDiscovery.js";

function presence(backendId: string, capabilities: string[], name = backendId): BackendPresenceV4 {
  return {
    namespace: "zcode",
    backendId,
    instanceId: "instance",
    deviceId: "device",
    name,
    channel: "zcode-remote",
    visible: true,
    capabilities,
    backendProtocolVersion: 1,
    epoch: 1,
    connectedAt: 1,
    lastSeenAt: 2,
  };
}

class FakeDiscoveryClient implements MobileRemoteDiscoveryClientLike {
  registry: BackendPresenceV4[] = [];
  connectError?: Error;
  discoverError?: Error;
  discovered = [
    { backendId: "backend-a", name: "Studio Mac", online: true, lastSeenAt: 1 },
    { backendId: "backend-b", name: "Office PC", online: false, lastSeenAt: 2 },
  ];
  closed = false;
  private registryHandlers = new Set<(items: BackendPresenceV4[]) => void>();

  onRegistry(handler: (items: BackendPresenceV4[]) => void): () => void {
    this.registryHandlers.add(handler);
    return () => this.registryHandlers.delete(handler);
  }

  async connect(): Promise<void> {
    if (this.connectError) {
      throw this.connectError;
    }
    this.emitRegistry(this.registry);
  }

  close(): void {
    this.closed = true;
  }

  async discoverBackends() {
    if (this.discoverError) {
      throw this.discoverError;
    }
    return this.discovered;
  }

  emitRegistry(items: BackendPresenceV4[]): void {
    this.registry = items;
    for (const handler of this.registryHandlers) {
      handler(items);
    }
  }
}

async function settle(snapshots: MobileRemoteBackendDiscoverySnapshot[]): Promise<void> {
  await vi.waitFor(() => {
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)?.loading).toBe(false);
  });
  // 让 discover/connect 两条异步通道都完成最后一次 emit。
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function collect(configure?: (client: FakeDiscoveryClient) => void): {
  client: FakeDiscoveryClient;
  snapshots: MobileRemoteBackendDiscoverySnapshot[];
  dispose: () => void;
} {
  const client = new FakeDiscoveryClient();
  // discovery/connect 在 start 时立即发起，测试必须在启动前配置好 fake 的初始状态。
  configure?.(client);
  const snapshots: MobileRemoteBackendDiscoverySnapshot[] = [];
  const dispose = startMobileRemoteBackendDiscovery({
    gatewayUrl: "https://gateway.example.com",
    namespace: "zcode",
    credential: "zgd_test",
    createClient: () => client,
    onUpdate: (snapshot) => snapshots.push(snapshot),
  });
  return { client, snapshots, dispose };
}

describe("mobile remote backend discovery (T4.2)", () => {
  it("marks a backend unsupported when registry has no remote-control capability", async () => {
    const { client, snapshots, dispose } = collect((fake) => {
      fake.registry = [presence("backend-a", [])];
    });
    await settle(snapshots);

    const latest = snapshots.at(-1)!;
    expect(latest.loading).toBe(false);
    expect(latest.backends).toEqual([
      {
        backendId: "backend-b",
        name: "Office PC",
        online: false,
        supported: true,
        lastSeenAt: 2,
      },
      {
        backendId: "backend-a",
        name: "backend-a",
        online: true,
        supported: false,
        lastSeenAt: 2,
      },
    ]);
    dispose();
    expect(client.closed).toBe(true);
  });

  it("merges registry names, online state and capabilities into the discovery list", async () => {
    const { snapshots, dispose } = collect((fake) => {
      fake.discovered = [
        { backendId: "backend-a", name: "Credential name", online: false, lastSeenAt: 1 },
      ];
      fake.registry = [
        presence("backend-a", [WEB_REMOTE_CONTROL_BACKEND_CAPABILITY], "Studio Mac"),
      ];
    });
    await settle(snapshots);

    const latest = snapshots.at(-1)!;
    expect(latest.backends).toEqual([
      {
        backendId: "backend-a",
        name: "Studio Mac",
        online: true,
        supported: true,
        lastSeenAt: 2,
      },
    ]);
    dispose();
  });

  it("maps a 401 discovery failure to gateway-credential-invalid", async () => {
    const { snapshots, dispose } = collect((fake) => {
      fake.discoverError = new Error("HTTP 401 Unauthorized");
    });
    await settle(snapshots);

    expect(snapshots.at(-1)?.failure).toMatchObject({ reason: "gateway-credential-invalid" });
    dispose();
  });

  it("keeps discovery data when only the registry connection fails", async () => {
    const { snapshots, dispose } = collect((fake) => {
      fake.connectError = new Error("network unreachable");
    });
    await settle(snapshots);

    const latest = snapshots.at(-1)!;
    expect(latest.failure).toMatchObject({ reason: "gateway-unreachable" });
    expect(latest.backends.map((backend) => backend.backendId)).toEqual(["backend-a", "backend-b"]);
    dispose();
  });

  it("maps a network discovery failure to gateway-unreachable", async () => {
    const { snapshots, dispose } = collect((fake) => {
      fake.discoverError = new Error("fetch failed");
    });
    await settle(snapshots);

    expect(snapshots.at(-1)?.failure).toMatchObject({ reason: "gateway-unreachable" });
    dispose();
  });
});
