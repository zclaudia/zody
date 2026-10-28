# 独立分支应用图标接入

## 产品规则

采用用户选定的第一版“分叉向前”缩小主体版本：`docs/brand/fork-icon-v1-smaller-15.png` 是唯一设计母版。保留石墨黑底和薄荷青分支箭头，不进一步修改造型或主体比例。替换 Desktop 和 Android 的系统应用图标，不改变应用名称、包标识、运行时或交互。

macOS 入口按 Apple 图标栅格出图：1024×1024 画布内，主体（含圆角底板）宽 824px，四周留约 100px 透明边距，即主体占 80.5%。Dock 与 Finder 都是把整张画布缩放进图标格子，留白算在内；主体满版时视觉上会比系统应用大一圈（旧资源为 896/1024 = 87.5%，实测比 Safari、Claude 等 824/1024 的图标大约 9%）。该规则只调整画布留白，不改造型与主体比例；设计母版本身仍是满版导出，栅格由交付资源承担。

## 资源所有者与入口

- Desktop：沿用 `packages/desktop/build/icon.png`、`icon_windows.png`、`icon.ico`、`icon.icns` 以及 `build/icons/*.png`。安装程序的 `icon_installer.*` 同步使用新品牌，保持现有独立入口。Electron Main 与 electron-builder 的加载路径不变。macOS 的 824 栅格由 `build/icon.png` 与 `build/icon.icns`（安装盘为 `icon_installer.icns`）共同承担：运行时还会通过 `app.dock.setIcon()` 加载 `Resources/icon.png`（源即 `build/icon.png`），只换 ICNS 不会改变 Dock 里的尺寸。
- 应用内首屏：桌面启动壳（`packages/desktop/src/renderer/index.html`）在 JS 执行前就要显示图标，因此使用同一母版的副本 `packages/desktop/src/renderer/public/brand/zody-logo.png`，并与 `packages/ui/src/assets/brand/zody-logo.png` 保持字节一致。React 接管后的 `RootStartupLoading`、引导欢迎页和 `WelcomeScreen` 直接使用 UI 包里的那份。该图与 `public/logo/icons/128x128.png` 是同一母版导出，自带圆角底板。首屏不再另画旧 Z 字形，也不再套一层深色标壳。
- 公共资源：`public/logo/icons/` 与 `public/icon_512@2x.png` 从同一母版导出。Web favicon 与 `index.html` 内嵌的 32px PNG 同步更新，保持现有同源约束。
- Android：保留 Manifest 的 `@mipmap/ic_launcher`、`@mipmap/ic_launcher_round` 接口。API 24–25 使用 mdpi 到 xxxhdpi 的静态 WebP；API 26+ 使用深色背景和透明箭头前景，由系统决定外轮廓。主题图标使用单独的白色 alpha 轮廓，避免整块底板被当成 monochrome 前景。
- Android adaptive 图层为 108dp 画布，箭头按约 46dp 宽等比放置于中心，完整主体位于中心 66dp 安全圆内，适配圆形、圆角矩形等 launcher mask。不会把已经带圆角底板的桌面图片直接塞入 adaptive 前景。

## 验收场景

1. Desktop PNG 与 Linux 各尺寸文件实际尺寸正确，ICO 包含 Windows 所需多尺寸，ICNS 包含 macOS 1024px 图层；透明外缘保留。macOS 入口的主体宽约为画布的 824/1024（80.5%），与系统应用一致；Windows `icon_windows.png` 与 Linux `build/icons/*.png` 仍为满版，不受该比例约束。
2. Desktop、公用图标、Windows 和安装图标均来自已选母版，不残留旧 Z 标志。桌面启动壳、启动阻塞画面和引导欢迎页同样只展示该母版，不包含旧 Z 字形路径。
3. Android 五档密度的普通、圆形图标均更新；adaptive 背景填满，透明前景只包含箭头，monochrome 为白色轮廓，且无默认机器人或绿色网格。
4. 检查圆形和圆角遮罩下的预览与 adaptive 前景安全区，执行 Android 资源编译任务。
5. 执行 Web 现有图标同源回归测试、`pnpm typecheck`、`pnpm lint` 和变更后架构检查。纯图标资源替换不增加交互 E2E。

## 边界

不修改服务端状态、远控流、workspace identity、owner/lease 或进程协议。无需新增状态所有者或异步事件路径。源目录中的其他未提交改动由原工作树保留。公共品牌资产（`public/logo/icons/`、`public/icon_512@2x.png`）与应用内首屏 logo 也保持满版，不套 macOS 栅格，避免 README 展示和 Web favicon 变小。Linux 托盘复用打包后的 `Resources/icon.png`（源 `build/icon.png`），因此会一并带上 macOS 留白、视觉上小约 10%；需要托盘满版时应改用独立的托盘资源，而不是回退 macOS 栅格。
