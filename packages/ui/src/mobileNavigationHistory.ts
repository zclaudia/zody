export type WebRemoteControlMobilePage = "home" | "chat";

interface WebRemoteControlMobileHistoryState {
  zcodeMobilePage?: WebRemoteControlMobilePage;
}

export function isWebRemoteControlMobileChatHistoryState(
  state: unknown,
): state is WebRemoteControlMobileHistoryState {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as WebRemoteControlMobileHistoryState).zcodeMobilePage === "chat"
  );
}
