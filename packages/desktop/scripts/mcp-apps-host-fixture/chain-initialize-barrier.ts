import assert from "node:assert/strict";
import { join } from "node:path";
import { webContents, type BrowserWindow } from "electron";
import { evaluateGuest } from "./guest-evaluation.js";

interface InitializeBarrierInput {
  agent: {
    session(
      workspacePath: string,
      source: string,
      serverName?: string,
      workspaceIdentity?: string,
      demo?: { serverScript: string; resourceUri: string },
      gateInitialize?: boolean,
    ): Promise<any>;
    events: {
      wait(match: (event: any) => boolean): Promise<unknown>;
      history: any[];
    };
    releaseInitialize(source: string): void;
    call(method: string, params: unknown): Promise<any>;
  };
  root: string;
  handles: Map<number, any>;
  guests: Map<number, any>;
  createWindow(scope: any, options?: { awaitReady?: boolean }): Promise<BrowserWindow>;
  closeWindow(win: BrowserWindow): Promise<void>;
  check(name: string, run: () => Promise<void>): Promise<void>;
}

/** 主进程 IPC 记录 prepare 请求，供首开屏障检查确认页面确实发起了打开。 */
export const initializeBarrierState = { prepareRequests: [] as string[] };

/**
 * 首开屏障的真实 Electron 场景：MCP server 收到 initialize 后先挂起，
 * 页面在此期间打开但不挂载；控制端放行后页面自动挂载，资源只读一次。
 */
export async function checkInitializeBarrier(input: InitializeBarrierInput): Promise<void> {
  const { agent, root, handles, guests, createWindow, closeWindow, check } = input;
  const { prepareRequests } = initializeBarrierState;
  const waitUntil = async (predicate: () => boolean, label: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const gatedPrepareCount = (sessionId: string) =>
    prepareRequests.filter((candidate) => candidate === sessionId).length;
  const gatedReads = (source: string) =>
    agent.events.history.filter((event) => event.type === "read" && event.source === source)
      .length;

  await check("first open waits for a gated initialize and mounts without a retry", async () => {
    const gatedScope = await agent.session(
      join(root, "workspace-gated"),
      "source-gated",
      "fixture",
      undefined,
      undefined,
      true,
    );
    // session/create 不等待 MCP startup；等 server 真正收到 initialize 再打开页面。
    await agent.events.wait(
      (event) => event.type === "initialize-waiting" && event.source === "source-gated",
    );
    const webviewsBefore = webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === "webview").length;
    const gated = await createWindow(gatedScope, { awaitReady: false });
    await waitUntil(() => gatedPrepareCount(gatedScope.sessionId) === 1, "gated prepare request");

    // initialize 未完成：页面不挂载、不读资源，也没有注册实例。
    assert.equal(handles.has(gated.webContents.id), false);
    assert.equal(
      webContents.getAllWebContents().filter((contents) => contents.getType() === "webview")
        .length,
      webviewsBefore,
    );
    assert.equal(gatedReads("source-gated"), 0);

    agent.releaseInitialize("source-gated");
    await gated.webContents.executeJavaScript("window.harnessReady");
    await evaluateGuest(guests.get(gated.webContents.id)!, "window.fixtureReady");

    // 放行后自动挂载，且资源只读一次；不存在第二次 initialize 或用户重试。
    assert.ok(handles.has(gated.webContents.id));
    assert.equal(
      webContents.getAllWebContents().filter((contents) => contents.getType() === "webview")
        .length,
      webviewsBefore + 1,
    );
    assert.equal(gatedReads("source-gated"), 1);
    assert.equal(gatedPrepareCount(gatedScope.sessionId), 1);
    await closeWindow(gated);
    await agent.call("session/close", { sessionId: gatedScope.sessionId });
  });
}
