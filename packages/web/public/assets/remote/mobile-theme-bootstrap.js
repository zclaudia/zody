/**
 * Remote 首屏主题兜底（M2-T2）。
 *
 * 从 `mobile.html` 的内联脚本外置为同源静态文件，保持原来的阻塞式执行顺序：
 * 该脚本位于 <head>，先于 body 末尾的 module bundle 执行，按本地偏好写入
 * `data-zcode-bootstrap-theme` / `data-zcode-browser-theme-surface`，避免深色主题用户
 * 在 WebView 里看到一帧白底。
 *
 * 为什么是 classic script 而不是 module：module 默认 defer，会把主题应用推迟到文档
 * 解析完成之后；这里需要与抽取前一致的首帧前初始化顺序。CSP `script-src 'self'`
 * 允许该同源文件，不需要 `unsafe-inline`。
 */
(() => {
  const BROWSER_THEME_COLORS = {
    dark: "#161616",
    light: "#f8f8f8",
  };

  const normalizeResolvedTheme = (theme) => {
    if (theme === "dark" || theme === "zai-dark") return "dark";
    if (theme === "light" || theme === "zai-light") return "light";
    return theme;
  };

  const syncBrowserThemeSurface = (theme) => {
    document.documentElement.setAttribute("data-zcode-browser-theme-surface", theme);
    document.documentElement.style.colorScheme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", BROWSER_THEME_COLORS[theme]);
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
  };

  try {
    const saved = localStorage.getItem("zody-theme") || "zai-dark";
    const resolved =
      saved === "system"
        ? window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : normalizeResolvedTheme(saved);
    const theme = resolved === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-zcode-bootstrap-theme", theme);
    syncBrowserThemeSurface(theme);
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    }
  } catch {
    document.documentElement.setAttribute("data-zcode-bootstrap-theme", "dark");
    syncBrowserThemeSurface("dark");
    document.documentElement.classList.add("dark");
  }
})();
