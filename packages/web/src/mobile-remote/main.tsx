import {
  generateMobileDeviceFingerprint,
  installDocumentHiddenMotionPause,
  setStreamClientId,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import { applyWebThemePreference } from "../webThemePreference.js";
import { bootstrapExternalRelayWebRemoteControl } from "./bootstrap.js";

/**
 * 手机入口（`mobile.html`，T1.2）。
 * 与桌面 Web 客户端的 `main.tsx` 分开打包：这里只做手机页面需要的最小初始化，然后交给
 * `mobile-remote/bootstrap.tsx` 启动远控流程。T4.2 的 gateway 设置页/选电脑页和 T6.1 的
 * Android 内置页面都从这里接入，不引入桌面 Web 客户端的 OAuth、分享页与 `/web-remote` 旧路径。
 */

installDocumentHiddenMotionPause();
applyWebThemePreference();
// 初始化流式 clientId，确保所有 hook 在首次渲染前就使用稳定 ID；
// 远控配对成功后 seedStableWebRemoteControlClientId 会按设备参数覆盖成持久 ID。
setStreamClientId(generateMobileDeviceFingerprint());

void bootstrapExternalRelayWebRemoteControl(new URLSearchParams(window.location.search));
