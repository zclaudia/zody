# 独立分支应用图标接入

## 产品规则

采用用户选定的第一版“分叉向前”缩小主体版本：`output/brand/fork-icon-v1-smaller-15.png` 是唯一设计母版。保留石墨黑底和薄荷青分支箭头，不进一步修改造型或主体比例。替换 Desktop 和 Android 的系统应用图标，不改变应用名称、包标识、运行时或交互。

## 资源所有者与入口

- Desktop：沿用 `packages/desktop/build/icon.png`、`icon_windows.png`、`icon.ico`、`icon.icns` 以及 `build/icons/*.png`。安装程序的 `icon_installer.*` 同步使用新品牌，保持现有独立入口。Electron Main 与 electron-builder 的加载路径不变。
- 公共资源：`public/logo/icons/` 与 `public/icon_512@2x.png` 从同一母版导出。Web favicon 与 `index.html` 内嵌的 32px PNG 同步更新，保持现有同源约束。
- Android：保留 Manifest 的 `@mipmap/ic_launcher`、`@mipmap/ic_launcher_round` 接口。API 24–25 使用 mdpi 到 xxxhdpi 的静态 WebP；API 26+ 使用深色背景和透明箭头前景，由系统决定外轮廓。主题图标使用单独的白色 alpha 轮廓，避免整块底板被当成 monochrome 前景。
- Android adaptive 图层为 108dp 画布，箭头按约 46dp 宽等比放置于中心，完整主体位于中心 66dp 安全圆内，适配圆形、圆角矩形等 launcher mask。不会把已经带圆角底板的桌面图片直接塞入 adaptive 前景。

## 验收场景

1. Desktop PNG 与 Linux 各尺寸文件实际尺寸正确，ICO 包含 Windows 所需多尺寸，ICNS 包含 macOS 1024px 图层；透明外缘保留。
2. Desktop、公用图标、Windows 和安装图标均来自已选母版，不残留旧 Z 标志。
3. Android 五档密度的普通、圆形图标均更新；adaptive 背景填满，透明前景只包含箭头，monochrome 为白色轮廓，且无默认机器人或绿色网格。
4. 检查圆形和圆角遮罩下的预览与 adaptive 前景安全区，执行 Android 资源编译任务。
5. 执行 Web 现有图标同源回归测试、`pnpm typecheck`、`pnpm lint` 和变更后架构检查。纯图标资源替换不增加交互 E2E。

## 边界

不修改服务端状态、远控流、workspace identity、owner/lease 或进程协议。无需新增状态所有者或异步事件路径。源目录中的其他未提交改动由原工作树保留。
