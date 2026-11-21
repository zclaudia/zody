# 独立分支应用图标接入

## 产品规则

采用用户选定的“机器人 Z”图标。`docs/brand/robot-z/zody-robot-icon.svg` 是应用图标母版，白色机器人与钴蓝底板使用纯色，面部留出 Z 字和双眼。`docs/brand/robot-z/zody-robot-mark.svg` 提供同一机器人的单色镂空轮廓，供 Android adaptive 图层使用。图标沿用现有资源路径、应用名称和包标识。

macOS 入口沿用 1024×1024 画布中的 824px 底板和 100px 透明边距，直接使用母版构图。其他满版资源按母版底板边界裁剪透明留白，并保留圆角外的透明区域。

## 资源所有者与入口

- Desktop：沿用 `packages/desktop/build/icon.png`、`icon_windows.png`、`icon.ico`、`icon.icns` 以及 `build/icons/*.png`。安装程序的 `icon_installer.*` 同步使用新品牌，保持现有独立入口。Electron Main 与 electron-builder 的加载路径不变。macOS 的 824 栅格由 `build/icon.png` 与 `build/icon.icns`（安装盘为 `icon_installer.icns`）共同承担：运行时还会通过 `app.dock.setIcon()` 加载 `Resources/icon.png`（源即 `build/icon.png`），只换 ICNS 不会改变 Dock 里的尺寸。
- 应用内首屏：桌面启动壳（`packages/desktop/src/renderer/index.html`）在 JS 执行前就要显示图标，因此使用同一母版的副本 `packages/desktop/src/renderer/public/brand/zody-logo.png`，并与 `packages/ui/src/assets/brand/zody-logo.png` 保持字节一致。React 接管后的 `RootStartupLoading`、引导欢迎页和 `WelcomeScreen` 直接使用 UI 包里的那份。该图与 `public/logo/icons/128x128.png` 是同一母版导出，自带圆角底板。首屏不再另画旧 Z 字形，也不再套一层深色标壳。
- 应用内其他品牌入口：Windows 标题区、折叠侧栏及更新说明直接复用 UI 包 `brand.ts` 提供的应用图标。供应商图标继续用于模型和供应商相关界面。
- 公共资源：`public/logo/icons/` 与 `public/icon_512@2x.png` 从同一母版导出。Web favicon 与 `index.html` 内嵌的 32px PNG 同步更新，保持现有同源约束。
- Android 沿用 Manifest 的 `@mipmap/ic_launcher` 和 `@mipmap/ic_launcher_round`。API 24–25 使用 mdpi 到 xxxhdpi 的静态 WebP，分别为圆角底板和圆形底板。API 26+ 由系统裁切钴蓝背景，前景和主题图标使用同一白色机器人轮廓，保留 Z 字和双眼的透明镂空。
- Android adaptive 图层为 108dp 画布。机器人约 46dp 宽，等比放置于中央，完整主体位于直径 66dp 的安全圆内。

## 验收场景

1. Desktop PNG 与 Linux 各尺寸文件实际尺寸正确，ICO 包含 Windows 所需多尺寸，ICNS 包含 macOS 1024px 图层；透明外缘保留。macOS 入口的主体宽约为画布的 824/1024（80.5%），与系统应用一致；Windows `icon_windows.png` 与 Linux `build/icons/*.png` 仍为满版，不受该比例约束。
2. 桌面图标、安装图标和公共资源均从机器人 Z 母版导出。桌面启动壳、启动阻塞画面和引导欢迎页的品牌图一致。
3. Android 五档密度的普通、圆形图标都显示机器人 Z。Adaptive 背景填满画布，前景与主题图标的 Z 字和双眼保留透明镂空。
4. 检查圆形和圆角遮罩下的预览与 adaptive 前景安全区，执行 Android 资源编译任务。
5. 执行 Web 现有图标同源回归测试、`pnpm typecheck`、`pnpm lint` 和变更后架构检查。纯图标资源替换不增加交互 E2E。

## 边界

不修改服务端状态、远控流、workspace identity、owner/lease 或进程协议。无需新增状态所有者或异步事件路径。源目录中的其他未提交改动由原工作树保留。公共品牌资产（`public/logo/icons/`、`public/icon_512@2x.png`）与应用内首屏 logo 也保持满版，不套 macOS 栅格，避免 README 展示和 Web favicon 变小。Linux 托盘复用打包后的 `Resources/icon.png`（源 `build/icon.png`），因此会一并带上 macOS 留白、视觉上小约 10%；需要托盘满版时应改用独立的托盘资源，而不是回退 macOS 栅格。
