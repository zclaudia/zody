/* eslint-disable max-lines -- Chrome API 子集与 attachment/claim 注册表共享同一 service-worker 生命周期。 */
import type {
  ExtensionAttachTarget,
  ExtensionTabClass,
  ExtensionTargetDetachReason,
  ExtensionTargetRef,
} from "@zcode/shared/browser-extension-transport";
import {
  findAttachmentByDebuggee,
  findAttachmentForTargetRef,
  type AttachmentMap,
} from "./attachmentRegistry.js";
import { LifecycleBarrier } from "./lifecycleBarrier.js";
import { log } from "./log.js";
import { STORAGE_KEYS } from "./storage.js";
import {
  isRecord,
  type CdpRequestPayload,
  type ClaimCancelPayload,
  type ClaimDecidePayload,
  type ClaimListPayload,
  type ClaimRequestPayload,
  type DetachAllPayload,
  type NativeAttachment,
  type NativeBridgeMessage,
  type PendingClaimRecord,
  type StorageGetPayload,
  type StorageRemovePayload,
  type StorageSetPayload,
  type TabsListPayload,
  type WorkerRequest,
  type WorkerResponse,
} from "./workerProtocol.js";

const OFFSCREEN_URL = "offscreen.html";
const DEBUGGER_PROTOCOL_VERSION = "1.3";
/** 在途 CDP 请求；cancel 只终止 evaluate/callFunctionOn，不伪称回滚导航或输入。 */
const inFlightCdp = new Map<
  string,
  { debuggee: ChromeDebuggee; method: string; nativeTabId: number }
>();

/** 生命周期清理屏障：detachAll 完成前不允许 create/attach/CDP 重建新 binding。 */
const detachAllBarrier = new LifecycleBarrier();

/**
 * 扩展安装/更新/重载会清空 storage.session。新生命周期必须清理旧 attachment 注册表，
 * 并用 storage.local 台账关闭上一生命周期创建的 agent tab；user tab 不在这里关闭。
 */
let extensionSessionCleanup: Promise<void> | null = null;

function cleanupNewExtensionSession(): Promise<void> {
  if (extensionSessionCleanup) return extensionSessionCleanup;
  extensionSessionCleanup = (async () => {
    await withAttachments(async (current) => {
      for (const key of Object.keys(current)) delete current[key];
      await persistAttachments(current);
    });
    await clearAllClaims();
    await closeAgentTabs(await collectAgentTabIds());
    log.info("cleaned previous extension session");
  })();
  return extensionSessionCleanup;
}

async function ensureOffscreenDocument(): Promise<void> {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl],
  });
  if (contexts.length > 0) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification:
        "Keep the authenticated loopback WebSocket to Zody desktop alive while debugging authorized tabs.",
    });
  } catch (error) {
    // 并发调用 ensure 时另一个路径可能已创建；复查后仍不存在才向上抛。
    const again = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [documentUrl],
    });
    if (again.length === 0) throw error;
  }
}

// attachment 注册表放在 chrome.storage.session：service worker 被回收后仍能校验
// attachmentId/connectionId，不会把过期引用当成有效 attachment。
let attachmentMutex: Promise<unknown> = Promise.resolve();

function withAttachments<T>(operation: (attachments: AttachmentMap) => Promise<T>): Promise<T> {
  const next = attachmentMutex.then(async () => {
    const values = await chrome.storage.session.get(STORAGE_KEYS.attachments);
    const attachments = (values[STORAGE_KEYS.attachments] as AttachmentMap | undefined) ?? {};
    return operation(attachments);
  });
  attachmentMutex = next.catch(() => undefined);
  return next;
}

async function persistAttachments(attachments: AttachmentMap): Promise<void> {
  await chrome.storage.session.set({ [STORAGE_KEYS.attachments]: attachments });
}

// agent tab 台账放在 storage.local：storage.session 会在扩展重载时清空，
// 台账仍能找回上一生命周期的 agent tab 并关闭。
let agentTabsMutex: Promise<unknown> = Promise.resolve();

function withAgentTabs<T>(operation: (agentTabs: Set<number>) => Promise<T>): Promise<T> {
  const next = agentTabsMutex.then(async () => {
    const values = await chrome.storage.local.get(STORAGE_KEYS.agentTabs);
    const raw = values[STORAGE_KEYS.agentTabs];
    const agentTabs = new Set<number>(Array.isArray(raw) ? raw.filter(Number.isInteger) : []);
    return operation(agentTabs);
  });
  agentTabsMutex = next.catch(() => undefined);
  return next;
}

async function persistAgentTabs(agentTabs: Set<number>): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.agentTabs]: [...agentTabs] });
}

// Pending claim 只用于 badge/Popup 展示；Host 才是授权事实的唯一所有者。
// service worker 被回收后仍能恢复展示，避免 badge 在等待授权时被清空。
type ClaimMap = Record<string, PendingClaimRecord>;
let claimMutex: Promise<unknown> = Promise.resolve();

function withClaims<T>(operation: (claims: ClaimMap) => Promise<T>): Promise<T> {
  const next = claimMutex.then(async () => {
    const values = await chrome.storage.session.get(STORAGE_KEYS.claims);
    const claims = (values[STORAGE_KEYS.claims] as ClaimMap | undefined) ?? {};
    return operation(claims);
  });
  claimMutex = next.catch(() => undefined);
  return next;
}

async function persistClaims(claims: ClaimMap): Promise<void> {
  await chrome.storage.session.set({ [STORAGE_KEYS.claims]: claims });
}

function claimCountAfterPrune(claims: ClaimMap, now = Date.now()): number {
  return Object.values(claims).filter((claim) => claim.expiresAt > now).length;
}

async function updateClaimBadge(claims: ClaimMap): Promise<void> {
  const count = claimCountAfterPrune(claims);
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  if (count > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: "#f5a623" });
  }
}

function pruneClaims(claims: ClaimMap, now = Date.now()): boolean {
  let changed = false;
  for (const [claimId, claim] of Object.entries(claims)) {
    if (claim.expiresAt > now) continue;
    delete claims[claimId];
    changed = true;
  }
  return changed;
}

async function handleClaimRequest(payload: unknown): Promise<WorkerResponse> {
  if (!isRecord(payload)) return toFailure("claim.request payload is invalid", "invalid_message");
  const request = payload as unknown as ClaimRequestPayload;
  if (
    typeof request.claimId !== "string" ||
    typeof request.nativeTabId !== "number" ||
    typeof request.expiresAt !== "number"
  ) {
    return toFailure("claim.request payload is invalid", "invalid_message");
  }
  await detachAllBarrier.wait();
  await withClaims(async (claims) => {
    // Host 保证同一窗口只有一个 pending；这里按 nativeTabId 去重，避免 badge 数量漂移。
    for (const [claimId, claim] of Object.entries(claims)) {
      if (claim.nativeTabId === request.nativeTabId) delete claims[claimId];
    }
    claims[request.claimId] = {
      claimId: request.claimId,
      nativeTabId: request.nativeTabId,
      expiresAt: request.expiresAt,
    };
    await persistClaims(claims);
    await updateClaimBadge(claims);
  });
  return { ok: true };
}

async function handleClaimCancel(payload: unknown): Promise<WorkerResponse> {
  if (!isRecord(payload)) return toFailure("claim.cancel payload is invalid", "invalid_message");
  const request = payload as unknown as ClaimCancelPayload;
  if (typeof request.claimId !== "string") {
    return toFailure("claim.cancel payload is invalid", "invalid_message");
  }
  await withClaims(async (claims) => {
    if (!claims[request.claimId]) return;
    delete claims[request.claimId];
    await persistClaims(claims);
    await updateClaimBadge(claims);
  });
  return { ok: true };
}

function sanitizePopupUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

async function handleClaimList(): Promise<WorkerResponse> {
  const claims = await withClaims(async (current) => {
    const changed = pruneClaims(current);
    if (changed) {
      await persistClaims(current);
      await updateClaimBadge(current);
    }
    return { ...current };
  });
  const entries = await Promise.all(
    Object.values(claims).map(async (claim) => {
      let title: string | undefined;
      let url: string | undefined;
      try {
        const tab = await chrome.tabs.get(claim.nativeTabId);
        title = tab.title;
        url = tab.url ? sanitizePopupUrl(tab.url) : undefined;
      } catch {
        // tab 已关闭时只返回 claim 本身；Host 会因 attach 失败或 TTL 清理。
      }
      return {
        ...claim,
        ...(title !== undefined ? { title } : {}),
        ...(url !== undefined ? { url } : {}),
      };
    }),
  );
  return { ok: true, data: { claims: entries } satisfies ClaimListPayload };
}

async function handleClaimDecide(payload: unknown): Promise<WorkerResponse> {
  if (!isRecord(payload)) return toFailure("claim.decide payload is invalid", "invalid_message");
  const request = payload as unknown as ClaimDecidePayload;
  if (
    typeof request.claimId !== "string" ||
    typeof request.nativeTabId !== "number" ||
    (request.decision !== "granted" &&
      request.decision !== "denied" &&
      request.decision !== "dismissed")
  ) {
    return toFailure("claim.decide payload is invalid", "invalid_message");
  }
  await detachAllBarrier.wait();
  const accepted = await withClaims(async (claims) => {
    const claim = claims[request.claimId];
    // 晚到/过期的 Popup 决定不能授权新 claim；不发送 decision，让 Host 继续超时清理。
    if (!claim || claim.nativeTabId !== request.nativeTabId) return false;
    if (claim.expiresAt <= Date.now()) {
      delete claims[request.claimId];
      await persistClaims(claims);
      await updateClaimBadge(claims);
      return false;
    }
    delete claims[request.claimId];
    await persistClaims(claims);
    await updateClaimBadge(claims);
    return true;
  });
  if (!accepted) {
    return toFailure("claim is no longer active", "target_unavailable");
  }
  // 用户决定必须先回到 Host；Host 只在 pending 仍匹配时才接受 granted。
  await sendNativeMessage({
    target: "offscreen",
    type: "native.claimDecision",
    claimId: request.claimId,
    nativeTabId: request.nativeTabId,
    decision: request.decision,
  });
  return { ok: true };
}

async function removeClaimsForTab(nativeTabId: number): Promise<PendingClaimRecord[]> {
  return withClaims(async (claims) => {
    const removed = Object.values(claims).filter((claim) => claim.nativeTabId === nativeTabId);
    for (const claim of removed) delete claims[claim.claimId];
    if (removed.length > 0) {
      await persistClaims(claims);
      await updateClaimBadge(claims);
    }
    return removed;
  });
}

function toFailure(
  message: string,
  failureCode: "target_unavailable" | "invalid_message" | "internal_error" = "internal_error",
): WorkerResponse {
  return { ok: false, error: { message, failureCode } };
}

function parseCdpError(error: unknown): { code?: number; message: string } {
  const message = error instanceof Error ? error.message : "CDP command failed";
  const match = /"code"\s*:\s*(-?\d+)/.exec(message);
  const code = match?.[1] ? Number.parseInt(match[1], 10) : undefined;
  return { ...(Number.isFinite(code) ? { code } : {}), message };
}

async function detachDebuggee(attachment: NativeAttachment): Promise<void> {
  const debuggee: ChromeDebuggee = attachment.targetId
    ? { targetId: attachment.targetId }
    : { tabId: attachment.nativeTabId };
  try {
    await chrome.debugger.detach(debuggee);
  } catch {
    // 已经 detach / tab 已关闭时保持清理幂等；不能因为清理失败留下注册表项。
  }
}

/** agent tab 只由 Zody 创建；台账写入失败时调用方必须关闭该 tab，避免留下孤儿。 */
async function rememberAgentTab(nativeTabId: number): Promise<void> {
  await withAgentTabs(async (agentTabs) => {
    if (agentTabs.has(nativeTabId)) return;
    agentTabs.add(nativeTabId);
    await persistAgentTabs(agentTabs);
  });
}

async function forgetAgentTab(nativeTabId: number): Promise<void> {
  await withAgentTabs(async (agentTabs) => {
    if (!agentTabs.delete(nativeTabId)) return;
    await persistAgentTabs(agentTabs);
  });
}

/** 浏览器重启后 nativeTabId 会变化；旧台账不能用于关闭新会话页面。 */
async function clearAgentTabLedger(): Promise<void> {
  await withAgentTabs(async (agentTabs) => {
    if (agentTabs.size === 0) return;
    agentTabs.clear();
    await persistAgentTabs(agentTabs);
  });
}

/** 扩展重载会清空 storage.session；本地台账用于找回旧 agent tab。 */
async function collectAgentTabIds(): Promise<number[]> {
  return withAgentTabs(async (agentTabs) => [...agentTabs]);
}

async function closeAgentTabs(nativeTabIds: Iterable<number>): Promise<void> {
  const ids = new Set(nativeTabIds);
  for (const nativeTabId of ids) {
    try {
      await chrome.tabs.remove(nativeTabId);
    } catch {
      // tab 已关闭/窗口已关闭时保持幂等；不能因清理失败留下业务状态。
    }
  }
  await withAgentTabs(async (agentTabs) => {
    let changed = false;
    for (const nativeTabId of ids) {
      if (agentTabs.delete(nativeTabId)) changed = true;
    }
    if (changed) await persistAgentTabs(agentTabs);
  });
}

async function clearAllClaims(): Promise<void> {
  await withClaims(async (claims) => {
    if (Object.keys(claims).length === 0) return;
    for (const key of Object.keys(claims)) delete claims[key];
    await persistClaims(claims);
    await updateClaimBadge(claims);
  });
}

async function handleTabsList(): Promise<WorkerResponse> {
  await detachAllBarrier.wait();
  const tabs = await chrome.tabs.query({});
  // DevTools 或其他扩展已占用的 tab 仍可列出，但 Host 会因此拒绝 claim。
  const attachedTabIds = new Set(
    (await chrome.debugger.getTargets().catch(() => []))
      .filter((target) => target.attached && typeof target.tabId === "number")
      .map((target) => target.tabId as number),
  );
  const payload: TabsListPayload = {
    tabs: tabs
      .filter((tab): tab is ChromeTab & { id: number } => tab.id !== undefined)
      .map((tab) => ({
        nativeTabId: tab.id,
        active: tab.active,
        url: tab.url ?? "",
        title: tab.title ?? "",
        ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
        ...(attachedTabIds.has(tab.id) ? { debuggerAttached: true } : {}),
      })),
  };
  return { ok: true, data: payload };
}

async function handleTabsCreate(payload: unknown): Promise<WorkerResponse> {
  if (!isRecord(payload) || payload.active !== false) {
    return toFailure("tabs.create only supports active:false", "invalid_message");
  }
  const url = typeof payload.url === "string" && payload.url ? payload.url : undefined;
  // 旧 cleanup 完成前不能创建新 agent tab，否则会被旧 collectAgentTabIds 快照关闭。
  await detachAllBarrier.wait();
  let createdTabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ ...(url ? { url } : {}), active: false });
    if (tab.id === undefined) {
      return toFailure("chrome.tabs.create did not return a tab id", "internal_error");
    }
    createdTabId = tab.id;
    // 标记 agent 归属；失败时关闭 tab，避免留下扩展重载后无法识别的孤儿。
    await rememberAgentTab(tab.id);
    return {
      ok: true,
      data: {
        tab: {
          nativeTabId: tab.id,
          active: tab.active,
          url: tab.url ?? url ?? "",
          title: tab.title ?? "",
          ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
        },
      },
    };
  } catch (error) {
    if (createdTabId !== undefined) {
      await chrome.tabs.remove(createdTabId).catch(() => undefined);
    }
    log.warn("tabs.create failed", error instanceof Error ? error.name : "unknown");
    return toFailure("could not create a background tab", "target_unavailable");
  }
}

async function handleTabsClose(payload: unknown): Promise<WorkerResponse> {
  if (!isRecord(payload) || typeof payload.nativeTabId !== "number") {
    return toFailure("tabs.close target is invalid", "invalid_message");
  }
  const nativeTabId = payload.nativeTabId;
  await detachAllBarrier.wait();
  // Agent 的 close 只关闭自己创建的 tab；先清理该 tab 的 attachment，再移除原生 tab。
  const attachments = await withAttachments(async (current) => {
    const found = Object.values(current).filter(
      (attachment) => attachment.nativeTabId === nativeTabId,
    );
    for (const attachment of found) delete current[attachment.attachmentId];
    if (found.length > 0) await persistAttachments(current);
    return found;
  });
  await Promise.all(attachments.map((attachment) => detachDebuggee(attachment)));
  try {
    await chrome.tabs.remove(nativeTabId);
  } catch (error) {
    // tab 已经关闭是幂等成功；其它失败必须保留结构化错误。
    const message = error instanceof Error ? error.message : "tabs.remove failed";
    if (/No tab with id/i.test(message)) {
      await forgetAgentTab(nativeTabId);
      return { ok: true };
    }
    log.warn("tabs.close failed", error instanceof Error ? error.name : "unknown");
    return toFailure("could not close the tab", "target_unavailable");
  }
  await forgetAgentTab(nativeTabId);
  return { ok: true };
}

async function handleAttach(payload: unknown): Promise<WorkerResponse> {
  if (!isRecord(payload) || !isRecord(payload.target)) {
    return toFailure("attach target is invalid", "invalid_message");
  }
  const target = payload.target as unknown as ExtensionAttachTarget;
  if (
    typeof target.nativeTabId !== "number" ||
    typeof target.browserGeneration !== "number" ||
    typeof target.connectionId !== "string" ||
    typeof target.browserId !== "string" ||
    (target.tabClass !== "agent" && target.tabClass !== "user")
  ) {
    return toFailure("attach target is invalid", "invalid_message");
  }
  const tabClass: ExtensionTabClass = target.tabClass;
  await detachAllBarrier.wait();
  const debuggee: ChromeDebuggee = target.targetId
    ? { targetId: target.targetId }
    : { tabId: target.nativeTabId };
  try {
    await chrome.debugger.attach(debuggee, DEBUGGER_PROTOCOL_VERSION);
  } catch (error) {
    log.warn("debugger attach failed", error instanceof Error ? error.name : "unknown");
    return toFailure("tab is not available for debugging", "target_unavailable");
  }
  if (tabClass === "agent" && !target.targetId) {
    // 幂等补齐 tab value：Host 创建的 agent tab 已在 tabs.create 标记，重连/重试不重复建 tab。
    await rememberAgentTab(target.nativeTabId).catch(() => undefined);
  }
  const attachment: NativeAttachment = {
    attachmentId: crypto.randomUUID(),
    browserId: target.browserId,
    browserGeneration: target.browserGeneration,
    connectionId: target.connectionId,
    nativeTabId: target.nativeTabId,
    tabClass,
    ...(target.targetId ? { targetId: target.targetId } : {}),
  };
  await withAttachments(async (attachments) => {
    attachments[attachment.attachmentId] = attachment;
    await persistAttachments(attachments);
  });
  let url: string | undefined;
  let title: string | undefined;
  if (!target.targetId) {
    try {
      const tab = await chrome.tabs.get(target.nativeTabId);
      url = tab.url;
      title = tab.title;
    } catch {
      // attach 成功后 tab 可能立即关闭；结果仍以 attachmentId 为准。
    }
  }
  return {
    ok: true,
    data: {
      attachmentId: attachment.attachmentId,
      nativeTabId: attachment.nativeTabId,
      ...(attachment.targetId ? { targetId: attachment.targetId } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(title !== undefined ? { title } : {}),
    },
  };
}

async function handleDetach(payload: unknown): Promise<WorkerResponse> {
  if (!isRecord(payload) || !isRecord(payload.targetRef)) {
    return toFailure("detach target is invalid", "invalid_message");
  }
  const targetRef = payload.targetRef as unknown as ExtensionTargetRef;
  await detachAllBarrier.wait();
  const attachment = await withAttachments(async (attachments) => {
    const found = findAttachmentForTargetRef(attachments, targetRef);
    if (!found) return null;
    delete attachments[targetRef.attachmentId];
    await persistAttachments(attachments);
    return found;
  });
  if (!attachment) return toFailure("attachment is not active", "target_unavailable");
  await detachDebuggee(attachment);
  return { ok: true };
}

async function handleCdpRequest(payload: unknown): Promise<WorkerResponse> {
  if (!isRecord(payload) || !isRecord(payload.targetRef)) {
    return toFailure("CDP target is invalid", "invalid_message");
  }
  const request = payload as unknown as CdpRequestPayload;
  const targetRef = request.targetRef;
  await detachAllBarrier.wait();
  const attachment = await withAttachments(async (attachments) =>
    findAttachmentForTargetRef(attachments, targetRef),
  );
  if (!attachment) return toFailure("attachment is not active", "target_unavailable");
  const effectiveTargetId = request.targetId ?? attachment.targetId;
  const debuggee: ChromeDebuggee = effectiveTargetId
    ? { targetId: effectiveTargetId }
    : { tabId: attachment.nativeTabId };
  if (typeof request.requestId === "string" && request.requestId) {
    inFlightCdp.set(request.requestId, {
      debuggee,
      method: request.method,
      nativeTabId: attachment.nativeTabId,
    });
  }
  try {
    const result = await chrome.debugger.sendCommand(
      debuggee,
      request.method,
      request.params ?? {},
    );
    return { ok: true, data: { result } };
  } catch (error) {
    return { ok: false, data: { error: parseCdpError(error) }, error: parseCdpError(error) };
  } finally {
    if (request.requestId) inFlightCdp.delete(request.requestId);
  }
}

/**
 * Host 取消只终止目标 evaluate/callFunctionOn。导航、点击等已下发动作无法回滚，
 * 这里不发送额外命令，也不伪造成功。
 */
async function handleRequestCancel(payload: unknown): Promise<WorkerResponse> {
  if (!isRecord(payload) || typeof payload.targetRequestId !== "string") {
    return toFailure("request.cancel payload is invalid", "invalid_message");
  }
  const entry = inFlightCdp.get(payload.targetRequestId);
  if (!entry) return { ok: true };
  if (entry.method !== "Runtime.evaluate" && entry.method !== "Runtime.callFunctionOn") {
    return { ok: true };
  }
  try {
    await chrome.debugger.sendCommand(entry.debuggee, "Runtime.terminateExecution", {});
  } catch {
    // 命令可能已经结束；尽力终止，不把取消失败包装成 CDP 结果。
  }
  return { ok: true };
}

async function handleDetachAll(payload: unknown): Promise<WorkerResponse> {
  // begin 同步占位 flight；之后到达的 create/attach/CDP 必须等待本次清理结束。
  const flight = detachAllBarrier.begin(() => runDetachAll(payload));
  try {
    await flight;
    return { ok: true };
  } catch (error) {
    log.warn("detachAll cleanup failed", error instanceof Error ? error.name : "unknown");
    return toFailure("detachAll cleanup failed", "internal_error");
  }
}

async function runDetachAll(payload: unknown): Promise<void> {
  const reason =
    isRecord(payload) && typeof payload.reason === "string"
      ? (payload.reason as ExtensionTargetDetachReason)
      : "socket_closed";
  const attachments = await withAttachments(async (current) => {
    const snapshot = Object.values(current);
    for (const key of Object.keys(current)) delete current[key];
    await persistAttachments(current);
    return snapshot;
  });
  await Promise.all(attachments.map((attachment) => detachDebuggee(attachment)));
  await clearAllClaims();
  // attachment 注册表是主事实；本地 agent tab 台账兜底注册表丢失的场景。
  const agentTabIds = new Set(
    attachments
      .filter((attachment) => attachment.tabClass === "agent")
      .map((attachment) => attachment.nativeTabId),
  );
  for (const nativeTabId of await collectAgentTabIds()) agentTabIds.add(nativeTabId);
  await closeAgentTabs(agentTabIds);
  inFlightCdp.clear();
  if (attachments.length > 0) {
    log.info("detached all debuggees", {
      count: attachments.length,
      agentTabs: agentTabIds.size,
      reason,
    });
  }
}

async function handleWorkerRequest(request: WorkerRequest): Promise<WorkerResponse> {
  switch (request.op) {
    case "tabs.list":
      return handleTabsList();
    case "tabs.create":
      return handleTabsCreate(request.payload);
    case "tabs.close":
      return handleTabsClose(request.payload);
    case "debugger.attach":
      return handleAttach(request.payload);
    case "debugger.detach":
      return handleDetach(request.payload);
    case "cdp.request":
      return handleCdpRequest(request.payload);
    case "request.cancel":
      return handleRequestCancel(request.payload);
    case "detachAll":
      return handleDetachAll(request.payload as DetachAllPayload | undefined);
    case "claim.request":
      return handleClaimRequest(request.payload);
    case "claim.cancel":
      return handleClaimCancel(request.payload);
    case "claim.list":
      return handleClaimList();
    case "claim.decide":
      return handleClaimDecide(request.payload);
    case "storage.get": {
      const { key } = request.payload as StorageGetPayload;
      const values = await chrome.storage.local.get(key);
      return { ok: true, data: { value: values[key] } };
    }
    case "storage.set": {
      const { key, value } = request.payload as StorageSetPayload;
      await chrome.storage.local.set({ [key]: value });
      return { ok: true };
    }
    case "storage.remove": {
      const { key } = request.payload as StorageRemovePayload;
      await chrome.storage.local.remove(key);
      return { ok: true };
    }
    default:
      return toFailure("unsupported worker operation", "invalid_message");
  }
}

async function sendNativeMessage(message: NativeBridgeMessage): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // offscreen 可能正在重建；事件不能重放，丢掉比缓存更符合 P0 语义。
    try {
      await ensureOffscreenDocument();
      await chrome.runtime.sendMessage(message);
    } catch {
      log.debug("native event dropped; offscreen document unavailable");
    }
  }
}

function toDetachReason(reason: string): ExtensionTargetDetachReason {
  if (reason === "canceled_by_user") return "user_cancel";
  if (reason === "target_closed") return "tab_closed";
  return "debugger_detached";
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isRecord(message) || message.target !== "worker") return false;
  if (message.type === "pairing.submit" || message.type === "reconnect") {
    void (async () => {
      // offscreen 被回收/关闭后 Popup 的 reconnect 必须能重建它，否则 socket 永远不重连。
      if (message.type === "reconnect") {
        await ensureOffscreenDocument().catch(() => undefined);
      }
      return await chrome.runtime.sendMessage({ ...message, target: "offscreen" });
    })()
      .then((response) => sendResponse(response ?? { ok: true }))
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: { message: error instanceof Error ? error.message : "offscreen unavailable" },
        });
      });
    return true;
  }
  const request = message as unknown as WorkerRequest;
  void handleWorkerRequest(request)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse(toFailure(error instanceof Error ? error.message : "worker failure"));
    });
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  void (async () => {
    const attachment = await withAttachments(async (attachments) =>
      findAttachmentByDebuggee(attachments, source),
    );
    if (!attachment) return;
    await sendNativeMessage({
      target: "offscreen",
      type: "native.event",
      attachment,
      method,
      params: params ?? {},
    });
  })();
});

chrome.debugger.onDetach.addListener((source, reason) => {
  void (async () => {
    const attachment = await withAttachments(async (attachments) => {
      const found = findAttachmentByDebuggee(attachments, source);
      if (!found) return null;
      delete attachments[found.attachmentId];
      await persistAttachments(attachments);
      return found;
    });
    if (!attachment) return;
    await sendNativeMessage({
      target: "offscreen",
      type: "native.detached",
      attachment,
      reason: toDetachReason(reason),
    });
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    await forgetAgentTab(tabId);
    // 待授权 tab 关闭时让 Host 立即清掉 pending，而不是等 2 分钟 TTL。
    for (const claim of await removeClaimsForTab(tabId)) {
      await sendNativeMessage({
        target: "offscreen",
        type: "native.claimDecision",
        claimId: claim.claimId,
        nativeTabId: claim.nativeTabId,
        decision: "dismissed",
      });
    }
    const removed = await withAttachments(async (attachments) => {
      const found = Object.values(attachments).filter(
        (attachment) => attachment.nativeTabId === tabId,
      );
      for (const attachment of found) delete attachments[attachment.attachmentId];
      if (found.length > 0) await persistAttachments(attachments);
      return found;
    });
    for (const attachment of removed) {
      await sendNativeMessage({
        target: "offscreen",
        type: "native.targetClosed",
        attachment,
      });
    }
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  // 扩展安装/更新/重载：storage.session 已清空，用本地台账关闭上一生命周期的 agent tab。
  // 浏览器启动只 ensure offscreen，不能用旧 tabId 关闭新会话，避免 id 复用误关用户页面。
  void cleanupNewExtensionSession()
    .catch(() => undefined)
    .then(() => ensureOffscreenDocument().catch(() => undefined));
});

chrome.runtime.onStartup.addListener(() => {
  // 浏览器重启会复用/重排 tabId；清掉旧台账，避免后续误关用户页面。
  void clearAgentTabLedger()
    .catch(() => undefined)
    .then(() => ensureOffscreenDocument().catch(() => undefined));
});

// service worker 每次被唤醒都确保 offscreen 存在；重复调用是幂等的。
// 不在普通 SW 冷启动清理 attachment：P0 的空闲保活要求已有 attachment 继续可用。
void ensureOffscreenDocument().catch(() => undefined);
// pending claim 存在 chrome.storage.session；SW 重启后恢复 badge，避免等待授权时 badge 消失。
void withClaims(async (claims) => {
  if (pruneClaims(claims)) await persistClaims(claims);
  await updateClaimBadge(claims);
}).catch(() => undefined);
