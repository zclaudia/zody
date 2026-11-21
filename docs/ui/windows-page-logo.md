# Windows 页面左上角 Logo

## 范围

- Windows 桌面端的 `SettingsPage` 左上角补充应用 logo。
- 仅增加品牌标识，不新增点击行为，也不改变现有返回、打开工作区、设置分区等交互。

## 实现

- `packages/ui/src/WindowsTopLeftLogo.tsx` 和工作区顶栏都使用 `brand.ts` 提供的机器人 Z 图标。
- `SettingsPage` 只在 `isWindowsDesktop` 条件下渲染该组件，继续保留顶部 `app-region:drag`。
