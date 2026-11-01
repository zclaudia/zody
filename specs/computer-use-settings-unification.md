# Computer Use 设置呈现统一规格

## 2026-11-01 设置分区显隐与内容改为按构建真实能力呈现（取代 0.1.0「隐藏不可用入口」决定）

### 背景与取代关系

`specs/zody-0.1.0-release.md`「系统级 Computer Use」条目原先规定「首发不宣称支持并隐藏不可用入口」。实施中发现隐藏只作用于设置页导航，产生了三处不一致：

1. 输入框常驻 CUA 入口按钮不受设置页隐藏影响：插件被启用（含 CLI 手工启用）即渲染，点击后跳设置页却因分区被过滤回落到 General，形成死胡同。
2. 占位构建里权限行底层连接 fail-closed 占位包（`@zcode/zcode-cua`），状态永远停留在「未知/Helper 启动中」语义，呈现失真。
3. 真实能力（macOS 窄截图链）由构建期 profile 决定，与设置开关脱钩——该边界由 `specs/computer-use-macos-phase1.md` 批准，本规格不改。

本规格仅取代 0.1.0 spec「系统级 Computer Use」条目中「隐藏不可用入口」这一决定，改为「如实呈现能力边界」；该条目其余内容（不宣称支持、保留 Browser Use）继续有效。

### 规则

**能力信号唯一所有者是 desktop Main。**

- 新增 desktop command `GetCuaCapability`（走既有 `PlatformChannels.ExecuteDesktopCommand` 通道，不新增 IPC 或协议面），返回 `CuaBuildCapability`：
  - `{ kind: "narrow", capabilities: ["screenshot.single-window"] }`：打包产物存在 `Resources/cua-narrow/manifest.json`（与 electron-builder afterPack `assertPackagedCuaNarrowResource` 同一事实源；仅 darwin 构建可能满足）。
  - `{ kind: "placeholder" }`：其余情况，含 dev 模式与查询失败（fail-closed）。
- 查询无副作用、幂等，可重复调用。Web 端没有 desktop command，能力信号不可得。

**呈现三态（设置页 computerUse 分区）。**

1. placeholder 构建：分区可见，整卡说明「此构建不含 Computer Use」（复用现有 warning 卡模式），不渲染总开关、权限行与输入框常驻入口；即使用户经 CLI 手工启用插件，入口也不渲染。
2. narrow 构建：分区可见，渲染总开关（插件启用态，落盘语义不变）与能力边界说明（当前仅单窗口截图；构建期条件不满足时自动回退普通 Agent，CUA 不可用）；macOS 权限区为说明性信息——屏幕录制权限由 macOS 在首次截图时按需请求，不渲染状态行、授权按钮或重启链。
3. Web：分区隐藏（与 remoteAccess 同模式）；远端 workspace / Linux 桌面维持现有 unsupported 卡与文案。

**分区导航可见性**：设置导航对桌面平台（macOS/Windows/Linux desktop）显示 computerUse 分区，Web 视图不显示；分区内容的实际形态由上述能力信号决定。导航层只管平台可见性，能力态归 `ComputerUseSection`，职责单一。

**开关语义（不变项）**：总开关只管插件面——skill 注入、node_repl 的 CUA 文档面、输入框入口显隐。它不控制窄链 eligibility；窄链仍由构建期 profile 与运行时启动匹配决定（phase1 spec 边界保留）。narrow 构建的能力边界文案必须如实说明这一点，不宣称开关控制窄链。

**输入框常驻入口**：在既有四层门（平台、设置、服务、插件）之后增加第五层门——能力信号为 placeholder 时整体不渲染。分区可见后，入口点击落点回到 computerUse 分区，死胡同消除。

### 已知边界（如实记录，不宣称已解决）

- 旧 Helper 的权限状态行、授权引导与重启链已从设置分区移除：其在 zody 的底层是 `@zcode/zcode-cua` 占位实现（fail-closed），保留只会产生恒为「未知」、点了只报「暂时无法确认」的失真呈现。接入窄链 Helper 的真实权限状态查询仍属 phase1 收尾范围，届时权限区将基于新事实源重建（`cuaPermissionAction` 等共享库保留供重建复用）。
- 窄链运行时 eligibility（provider/network digest、workspace allowlist、OS/arch）不在此信号内：narrow 构建只代表「打包了窄资源」，不代表当前会话一定可用。

### 验收场景

1. 占位构建（当前官方构建，无 cua-narrow 资源）：设置页 computerUse 分区可见并显示说明卡；无总开关；无权限行；输入框 CUA 入口不渲染（即使插件已启用）。
2. narrow 构建（打包 cua-narrow 资源）：分区可见；总开关可切换并落盘插件启用态；能力边界说明展示；macOS 权限区渲染屏幕录制说明行（无状态行、无授权/重启按钮，不触发任何权限查询）。
3. Web 视图：设置导航无 computerUse 分区。
4. 远端 workspace / Linux 桌面：分区呈现既有 unsupported 卡，不渲染任何本地 CUA 写操作控件。
5. `GetCuaCapability` 查询失败或超时：按 placeholder 呈现（fail-closed），不阻塞设置页其余分区。
6. 输入框 CUA 入口（narrow 构建 + 插件启用 + 用户未隐藏）点击后落点是设置页 computerUse 分区，不再是 General。
