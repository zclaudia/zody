# Login Page

启动阶段如果没有可用模型供应商配置，Root 会展示 `WelcomeScreen`。fork（F4.1b）起官方账号 / OAuth 入口已摘除，`WelcomeScreen` 只承载 BYOK（自带 API Key）引导，复用 `LoginApiKeyForm` 一条保存路径：

- 启动自动引导：`WelcomeScreen`，由 provider 可用性守卫打开
- 手动入口：从设置页或 workspace shell 打开同一个 `WelcomeScreen`

保存 API Key 或点击“暂时跳过”后，欢迎页关闭并回到正常 Root 路由。

## 布局（Split onboarding）

欢迎页是全窗口 overlay，采用左右分栏：

- **左侧品牌栏**（`md` 及以上可见）：`bg-sidebar` + 右侧 `border-border` 分隔。自上而下为品牌行（新 logo + 名称 `zcoder`）、主标语、三条价值说明（任意 provider / 密钥只保存在本机 / 按会话切换模型），底部是一张纯装饰的终端预览卡（`aria-hidden`）。价值说明图标使用 `--color-logo-accent`，该 token 取自新 logo 的薄荷绿，只用于品牌强调，不得替代语义色。
- **右侧表单栏**：垂直居中，最大宽度 `max-w-sm`。标题 `login.title`（“Welcome to zcoder”）、副标题 `login.description`，下方是 `LoginApiKeyForm`。
- **窄窗口 / 手机 Web**（`md` 以下）：隐藏左侧品牌栏，表单栏顶部改为展示品牌行（logo + `zcoder`），DOM 顺序保持“品牌 → 标题 → 表单”。
- 背景为纯 `bg-background`，不再叠加主题 hero 渐变；不使用装饰性渐变。
- Windows / Linux 继续复用 `DesktopOverlayWindowControls` 与顶部拖拽层，规则见 `DESIGN.md` 的 Full-page desktop overlays。

品牌名 `zcoder` 与新 logo（`packages/ui/src/assets/brand/zcoder-logo.png`，源自 `public/logo/icons/128x128.png`）目前只用于欢迎页；其它界面的品牌替换不在本规则范围内。品牌名是专有名词，不进入 i18n，各语言一致。

## API Key 表单

- **Provider**：带可见标签 `login.apiKey.providerLabel` 的下拉框，列出 Host 下发的 `access.type === "api-key"` 模板；初始未选择，展示占位 `login.apiKey.providerPlaceholder`。
- **API key**：带可见标签 `login.apiKey.title` 的密码输入框。未选择 provider 时禁用，占位改为 `login.apiKey.providerFirstPlaceholder`；选择后可输入，回车提交。
- **获取 API Key 外链**：输入框为空且所选模板提供 `apiKeyManagementUrl` 时，在输入框右侧展示 `login.apiKey.getApiKey`；已输入后隐藏，避免占用密钥编辑空间。外链通过 `IPlatformService.openExternal()` 打开，只负责跳转，不参与保存。
- **继续**：未选择 provider 或输入为空时禁用；保存成功后标记 API Key 登录成功并以 provider 第一个模型作为默认模型偏好。
- **暂时跳过**：使用 `login.apiKey.skip`（中英文均必须存在，缺失会把 key 原样渲染）。跳过只关闭欢迎页，不保存 API Key、不触发 API Key 登录成功事件，也不写 provider 运行域设置。

## 跳过后的首页

用户点击“跳过”或从其它入口进入没有可用模型的空草稿首页时，首页必须展示已有的 `modelConfigMissing` 错误横幅，提供模型配置入口。该横幅只投影本地 provider readiness，不触发 Agent 启动、deferred draft session 创建、联网探测或预热失败重试；保存合法 provider/model 并完成草稿模型水合后自动清除。

空草稿同时展示 workspace / Git context header 时，错误横幅必须作为独立 surface 位于输入卡外壳上方，不能嵌入包裹 context header 与编辑器的圆角卡片；横幅与输入卡之间固定保留 `mb-6`（24px）间距。视觉顺序固定为“错误横幅 → 独立间距 → 选择工作区 / Git 分支 → 输入框”。桌面端和手机 Web 端使用同一 DOM 顺序与容器层级；响应式布局只能改变换行和密度，不能把错误横幅移动到工作区入口下方或重新并入输入卡外壳。

启动自动引导完成后有一个新用户直达路径：如果当前没有已打开 workspace，Root 使用 Main 注入的 conversation descriptor，必要时通过 `fileService.ensureConversationWorkspace()` 幂等确保 `<dataBaseDir>/.zcode/workspace/default` 存在。该 workspace 提供真实 cwd，但 UI 保持“未选择项目”，用户无需经过项目选择页即可直接对话。若用户跳过登录且仍没有可用模型，该草稿首页按上一条规则显示 `modelConfigMissing` 横幅。

手动入口完成后只关闭 `WelcomeScreen` 并回到原界面，不会创建默认 workspace。

## 验收场景

1. 首启无 provider：桌面宽窗口展示左右分栏，左侧有 `zcoder` 品牌行与三条价值说明；右侧标题为“Welcome to zcoder”/“欢迎使用 zcoder”。
2. 未选择 provider：下拉框展示占位文案，API key 输入框禁用，继续按钮禁用；跳过按钮显示“Skip for now”/“暂时跳过”而非 i18n key。
3. 选择带 `apiKeyManagementUrl` 的模板：输入框可用并显示“Get API Key”；输入密钥后链接隐藏、继续按钮可用。
4. 窗口宽度低于 `md`（含手机 Web）：左侧品牌栏隐藏，表单上方展示品牌行。
5. Zai Light 与 Zai Dark 下文字对比度满足 4.5:1；Windows / Linux 窗控可达。
