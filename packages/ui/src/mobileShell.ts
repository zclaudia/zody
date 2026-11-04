/**
 * Shell 轻壳的 UI 公开入口（M2-T1）。
 *
 * Shell 只需要配对设置页、选电脑页、国际化 Provider 和移动端启动副作用；从 `@zcode/ui`
 * 根入口导入会把 Remote 工作台、PDF/Office 预览等按需模块一起打进 APK。这里收敛为
 * 明确的白名单，既复用现有组件，又保证 Shell 产物不含 Remote 资源。
 */
export { ZCodeIntlProvider } from "./i18n/IntlProvider.js";
export {
  WebRemoteControlMobileSettingsScreen,
  type WebRemoteControlMobileSettingsDraft,
  type WebRemoteControlMobileSettingsScreenProps,
} from "./WebRemoteControlMobileSettingsScreen.js";
export {
  WebRemoteControlMobileBackendPicker,
  type WebRemoteControlMobileBackendPickerProps,
} from "./WebRemoteControlMobileBackendPicker.js";
export { installDocumentHiddenMotionPause } from "./lib/documentHiddenMotionPause.js";
export { installMobileKeyboardInsetTracker } from "./lib/mobileKeyboardInset.js";
