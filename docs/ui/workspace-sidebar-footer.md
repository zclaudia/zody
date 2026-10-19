# Workspace Sidebar Footer（侧栏左下偏好面板）

## 背景

fork（F4.1b / F4.7）起官方账号与 OAuth 登录已下线，`UserInfo` 不再写入 UI store。侧栏左下角原“头像 + Connect”入口与菜单内的账号头部（头像、昵称、用户 ID 复制）已没有业务含义，菜单只剩语言、主题、界面模式、缩放四个偏好二级菜单。

## 规则（方案 1A：Labeled rows）

### 触发器

- 左侧按钮展示 zcoder logo（`packages/ui/src/assets/brand/zcoder-logo.png`）+ 品牌名 `zcoder` + 向上箭头，不再展示头像或“Connect”。品牌名为专有名词，不进入 i18n。
- 按钮沿用 `data-testid="login-trigger"`（`TID_LOGIN_TRIGGER`）以保持 E2E 选择器稳定；该 id 为历史命名，不代表登录语义。`aria-label` 使用 `sidebar.preferences.title`。
- 右侧 Web 远控入口与设置/返回按钮保持不变。

### 面板

点击触发器打开 `Popover`（不再使用 `DropdownMenu`，以便面板内的分段控件可用 Tab / 方向键操作）。面板自上而下：

1. **品牌头部**：logo + `zcoder`，仅展示，不可点击。UI 当前没有应用版本读取能力，不展示版本号。
2. 分隔线。
3. **偏好行**：每行左侧标签、右侧紧凑控件，行高 40px，顺序固定为 Theme → Language → Interface mode → Zoom：
   - **Theme**（`settings.themeMode`）：图标分段控件，选项 System / Light / Dark，分别对应 `system` / `zai-light` / `zai-dark`，选项 `aria-label` 复用 `sidebar.settings.*` 文案。
   - **Language**（`settings.locale`）：紧凑 `Select`，选项 跟随系统 / English / 中文简体（`system` / `en-US` / `zh-CN`）。
   - **Interface mode**（`settings.interfaceMode`）：文字分段控件 Coding / Office（`coding` / `office`，文案 `sidebar.preferences.mode.*`）。
   - **Zoom**（`sidebar.settings.interfaceZoom`，仅 `isDesktop`）：步进器 `−` / 当前百分比 / `+`。百分比为 `round(100 × 1.1^level)`，倍率规则与 desktop main 共用 `@zcode/shared` 的 `resolveDesktopZoomFactorForLevel`，不在 UI 另写常量。点击百分比执行 `ResetZoom`；边界禁用规则与 `docs/desktop/sidebar-zoom-menu.md` 一致（`+5` 禁用放大、`-3` 禁用缩小、默认档禁用重置）。

分段控件使用 `role="radiogroup"` / `role="radio"`：选中项 `tabIndex=0`，其余 `-1`；左右方向键在选项间移动并立即生效。

### 状态所有者

面板不持有偏好状态，全部通过既有回调写入原所有者：主题与语言走调用方传入的 `onThemeChange` / `onLocaleChange`，界面模式走 store 的 `setInterfaceMode`，缩放走 `platform.executeDesktopCommand` 并订阅 `onDesktopZoomLevelChanged` 读取最新档位。面板只保存自身开关状态。

### 移除

- 删除 `WorkspaceSidebarFooter` 的 `user` 属性及账号头部、用户 ID 复制逻辑，调用方（`WorkspaceSidebar`、`SettingsPage`）同步不再传入。
- 删除仅被该头部使用的 `sidebar.profile.*` 文案，以及对应的 manual-review pending 用例 `sidebar-user-id`。

## 验收场景

1. 侧栏左下角显示 zcoder logo 与名称，不出现“Connect”或默认头像。
2. 打开面板依次看到 Theme、Language、Interface mode、（桌面端）Zoom 四行；当前值高亮。
3. 点击 Light / Dark / System 立即切换主题；切换语言后面板文案即时更新。
4. 切换 Office / Coding 后界面模式生效，面板保持打开。
5. 桌面端点击 `+` / `−` / 百分比分别放大、缩小、重置，百分比与快捷键、View 菜单触发后的档位同步。
6. 设置页左下角复用同一面板，右侧按钮为“返回”。
7. Zai Light / Zai Dark 下文字对比度 ≥ 4.5:1；键盘可 Tab 进入各控件，方向键切换分段选项，Esc 关闭面板。
