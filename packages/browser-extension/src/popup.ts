import { EXTENSION_ID } from "./constants.js";
import { STORAGE_KEYS, type BridgeStatus, type StoredPairingChallenge } from "./storage.js";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element: ${id}`);
  return found as T;
}

const statusText = element<HTMLDivElement>("status");
const pairingBox = element<HTMLDivElement>("pairing-box");
const pairingSession = element<HTMLElement>("pairing-session");
const pairingCode = element<HTMLInputElement>("pairing-code");
const pairButton = element<HTMLButtonElement>("pair");
const reconnectButton = element<HTMLButtonElement>("reconnect");
const messageText = element<HTMLParagraphElement>("message");
const extensionIdText = element<HTMLElement>("extension-id");
const profileIdText = element<HTMLElement>("profile-id");
const bridgePortInput = element<HTMLInputElement>("bridge-port");
const claimsBox = element<HTMLElement>("claims-box");
const claimsList = element<HTMLDivElement>("claims-list");

interface PopupClaim {
  claimId: string;
  nativeTabId: number;
  expiresAt?: number;
  title?: string;
  url?: string;
}

let renderedClaims: PopupClaim[] = [];
let renderedSignature = "";

interface PopupState {
  status?: BridgeStatus;
  pairing?: StoredPairingChallenge;
  profileInstanceId?: string;
  bridgePort?: number;
}

async function readState(): Promise<PopupState> {
  const values = await chrome.storage.local.get([
    STORAGE_KEYS.status,
    STORAGE_KEYS.pairing,
    STORAGE_KEYS.profileInstanceId,
    STORAGE_KEYS.bridgePort,
  ]);
  return {
    status: values[STORAGE_KEYS.status] as BridgeStatus | undefined,
    pairing: values[STORAGE_KEYS.pairing] as StoredPairingChallenge | undefined,
    profileInstanceId: values[STORAGE_KEYS.profileInstanceId] as string | undefined,
    bridgePort: values[STORAGE_KEYS.bridgePort] as number | undefined,
  };
}

function render(state: PopupState): void {
  const status = state.status;
  statusText.textContent = status?.state ?? "idle";
  statusText.dataset.state = status?.state ?? "idle";
  messageText.textContent = status?.message ?? "";
  extensionIdText.textContent = chrome.runtime.id ?? EXTENSION_ID;
  profileIdText.textContent = state.profileInstanceId ?? "not initialized";
  const activePairing = state.pairing;
  const canPair = Boolean(activePairing) && status?.state === "pairing";
  pairingBox.hidden = !activePairing;
  pairingSession.textContent = activePairing?.pairingSessionId ?? "";
  // 用户正在输入时不能被 1 秒轮询覆盖；未聚焦时始终展示扩展实际保存的端口。
  if (document.activeElement !== bridgePortInput) {
    bridgePortInput.value = state.bridgePort ? String(state.bridgePort) : "";
  }
  pairButton.disabled = !canPair;
  reconnectButton.disabled = status?.state === "connecting";
}

async function refresh(): Promise<void> {
  render(await readState());
  await refreshClaims();
}

async function refreshClaims(): Promise<void> {
  let claims: PopupClaim[];
  try {
    const response = await chrome.runtime.sendMessage({ target: "worker", op: "claim.list" });
    const data =
      typeof response === "object" && response !== null && "data" in response
        ? (response as { data?: { claims?: unknown } }).data
        : undefined;
    claims = Array.isArray(data?.claims) ? (data.claims as PopupClaim[]) : [];
  } catch {
    // service worker 正在重启时保持上一次展示，不伪造“已授权”。
    return;
  }
  renderClaims(claims);
}

function renderClaims(claims: PopupClaim[]): void {
  const signature = claims
    .map((claim) => `${claim.claimId}:${claim.nativeTabId}:${claim.title ?? ""}:${claim.url ?? ""}`)
    .sort()
    .join("|");
  renderedClaims = claims;
  claimsBox.hidden = claims.length === 0;
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  claimsList.replaceChildren(
    ...claims.map((claim) => {
      const row = document.createElement("div");
      row.className = "claim";
      const title = document.createElement("div");
      title.className = "claim-title";
      title.textContent = claim.title || "Untitled tab";
      const url = document.createElement("div");
      url.className = "claim-url";
      url.textContent = claim.url ?? "";
      const actions = document.createElement("div");
      actions.className = "claim-actions";
      const approve = document.createElement("button");
      approve.type = "button";
      approve.textContent = "Allow";
      approve.addEventListener("click", () => void decideClaim(claim, "granted"));
      const deny = document.createElement("button");
      deny.type = "button";
      deny.className = "deny";
      deny.textContent = "Deny";
      deny.addEventListener("click", () => void decideClaim(claim, "denied"));
      actions.append(approve, deny);
      row.append(title, url, actions);
      return row;
    }),
  );
}

async function decideClaim(claim: PopupClaim, decision: "granted" | "denied"): Promise<void> {
  // 先本地移除按钮，避免双击产生第二个决定；Host 仍只接受第一个匹配 pending。
  renderedClaims = renderedClaims.filter((candidate) => candidate.claimId !== claim.claimId);
  renderedSignature = "";
  renderClaims(renderedClaims);
  try {
    await chrome.runtime.sendMessage({
      target: "worker",
      op: "claim.decide",
      payload: {
        claimId: claim.claimId,
        nativeTabId: claim.nativeTabId,
        decision,
      },
    });
  } catch (error) {
    messageText.textContent =
      error instanceof Error ? error.message : "could not submit the claim decision";
  }
}

// Popup 关闭且未决定时按 dismissed 处理；Host 对晚到/未知决定 fail closed。
window.addEventListener("pagehide", () => {
  for (const claim of renderedClaims) {
    void chrome.runtime
      .sendMessage({
        target: "worker",
        op: "claim.decide",
        payload: {
          claimId: claim.claimId,
          nativeTabId: claim.nativeTabId,
          decision: "dismissed",
        },
      })
      .catch(() => undefined);
  }
});

pairButton.addEventListener("click", () => {
  const code = pairingCode.value.trim();
  const session = pairingSession.textContent?.trim() ?? "";
  if (!code || !session) return;
  pairButton.disabled = true;
  messageText.textContent = "Submitting pairing proof...";
  void chrome.runtime
    .sendMessage({
      target: "worker",
      type: "pairing.submit",
      pairingCode: code,
      pairingSessionId: session,
    })
    .then((response) => {
      const ok =
        typeof response === "object" && response !== null && "ok" in response
          ? Boolean((response as { ok?: unknown }).ok)
          : false;
      if (!ok) {
        const error =
          typeof response === "object" && response !== null && "error" in response
            ? (response as { error?: { message?: string } }).error?.message
            : undefined;
        messageText.textContent = error ?? "pairing submission failed";
        pairButton.disabled = false;
      }
    })
    .catch((error: unknown) => {
      messageText.textContent =
        error instanceof Error ? error.message : "pairing submission failed";
      pairButton.disabled = false;
    });
});

reconnectButton.addEventListener("click", () => {
  const port = Number(bridgePortInput.value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    messageText.textContent = "Bridge port must be an integer between 1 and 65535";
    return;
  }
  messageText.textContent = "Saving bridge port...";
  void chrome.storage.local
    .set({ [STORAGE_KEYS.bridgePort]: port })
    .then(() => chrome.runtime.sendMessage({ target: "worker", type: "reconnect" }))
    .then(() => {
      messageText.textContent = "";
    })
    .catch((error: unknown) => {
      messageText.textContent =
        error instanceof Error ? error.message : "could not save the bridge port";
    });
});

void refresh();
setInterval(() => {
  void refresh();
}, 1_000);
