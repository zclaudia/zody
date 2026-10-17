import { createRoot } from "react-dom/client";

/**
 * 浏览器入口共用的 React 根（T1.2）。
 * 桌面 Web 客户端（`index.html`）与手机入口（`mobile.html`）各自独立打包，同一页面只会加载
 * 其中一份 bundle，因此这里直接按 `#root` 创建一个根，供两条入口的渲染复用。
 */
export const webEntryRoot = createRoot(document.getElementById("root")!);
