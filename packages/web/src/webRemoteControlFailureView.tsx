import type { WebRemoteControlFailure, WebRemoteControlFailureReason } from "@zcode/shared";
import { webEntryRoot } from "./webEntryRoot.js";
import {
  WebRemoteControlFailureScreen,
  resolveWebRemoteControlScreenLocale,
} from "./webRemoteControlFailureScreen.js";

/**
 * 失败页渲染与失败值构造（T1.2）：桌面 Web 客户端的 `/remote*` 路由与手机入口（mobile.html）
 * 共用同一份实现，避免两条入口各自维护一套失败展示。
 */

export function renderWebRemoteControlFailure(failure: WebRemoteControlFailure): void {
  webEntryRoot.render(
    <WebRemoteControlFailureScreen
      failure={failure}
      locale={resolveWebRemoteControlScreenLocale(navigator.language)}
      onReload={() => {
        window.location.reload();
      }}
    />,
  );
}

export function toWebRemoteControlFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}
