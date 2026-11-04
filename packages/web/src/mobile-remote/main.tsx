import {
  installDocumentHiddenMotionPause,
  installMobileKeyboardInsetTracker,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import { applyWebThemePreference } from "../webThemePreference.js";
import { bootstrapGatewayWebRemoteControl } from "./bootstrap.js";

/**
 * 手机入口（`mobile.html`，T1.2）。
 * 与桌面 Web 客户端的 `main.tsx` 分开打包：这里只做手机页面需要的最小初始化，然后交给
 * `mobile-remote/bootstrap.tsx` 启动远控流程。T4.2 的 gateway 设置页/选电脑页和 T6.1 的
 * Android 内置页面都从这里接入，不引入桌面 Web 客户端的 OAuth、分享页与 `/web-remote` 旧路径。
 */

installDocumentHiddenMotionPause();
// 键盘避让基座（spec docs/web-remote-control/mobile-viewport-input-and-touch.md §2.2，D2 本轮实施）：
// 安装 --zcode-keyboard-inset 的唯一所有者，覆盖 iOS Safari 侧软键盘避让（Android 侧由 mobile.html
// viewport 的 interactive-widget=resizes-content 承担）。变量生命周期等于页面，与组件挂载无关，
// 故与 installDocumentHiddenMotionPause 同样丢弃卸载函数；无 visualViewport 的环境安装为安全无操作。
installMobileKeyboardInsetTracker();
applyWebThemePreference();
// M2-T2：clientInstanceId 只来自原生 session context，bootstrap 在读取并校验后
// 立即调用 setStreamClientId；入口不再生成指纹或写入 localStorage。
void bootstrapGatewayWebRemoteControl(new URLSearchParams(window.location.search));
