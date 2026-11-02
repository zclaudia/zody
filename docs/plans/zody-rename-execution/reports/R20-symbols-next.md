# R20.4 下一组准备

状态：作者交付后由主控固化为 `e79eab7d`，并获 DeepSeek 限定 PASS；基线 `6720cfe22b8e16e6abcc4abbeee0d084f17594cb`。以下提案为历史准备，实际结果见文末；最终全量内部改名仍有后续组。

## runtimeEnv / env

`output/zody-rename-r20-symbols/batch-next/runtime-bindings.patch` 对应 `runtime-patch-plan.json`：19 个声明/绑定（共享公开类型、函数及本地 binding），40 个现行源码/测试文件、198 个改动位置。所有源码文件及逐位置引用在 JSON 中；sha256 用于应用前复核。ts-morph 在单个项目上下文加载授权的根与 CLI sourceFiles，语言服务引用记录在 `runtime-bindings.json`，逐 identifier 交叉检查见 `unresolved-identifiers.json`。七个 namespace/member 引用经检查是模块 API；五个未绑定属性是 `vi.mock("@zody/shared")` 工厂的模块导出键，需随 export 同步；不是需保留的外部消息字段。`official-plugin-definitions.ts` 中同名命中仅注释。不能以这些静态证据推断反射、字符串调用或 manualReviewPaths 已闭合。

不得更改 `ZCODE_*`/`__ZCODE_*__` 的实际 env/define、telemetry 上报值、持久化或 wire 字符串；这里只改可解析的内部标识。应用后重新以 AST 及 grep 检查旧名，按实际 public export 和所有消费者分类，不能给旧导出补 alias 掩盖残留。

`mapZCodeEnvToArmsRumEnv` 的源码消费包括 `packages/desktop/src/shared/armsRumShared.ts`，其同目录 tracked `armsRumShared.js` / `armsRumShared.js.map` 也含运行时引用，应从修改后的源码和继承配置在隔离目录真实 emit、比较全部差异与 source map 的相对 sources，再复制已授权的两个生成物；若 `.d.ts`/`.d.ts.map` 产生变化，同样比较并经授权同步。不能只手改 JS 或声明。目标时序是源码→shared/其引用构建→生成 companion→干净重建 CLI adapters、core、bootstrap 的实际必要 dist→测试；构建前锁定输出并备份，不安装、不改 lock。

当前旧 dist 消费确认为：adapters `dist/plugins/marketplace.js`、`dist/mcp/network.js`；bootstrap `dist/telemetry-bootstrap.js`、`dist/mcp-config.js`、`dist/plugins.js`、`dist/app/create-app.js`、`dist/app/bundled-plugins.js`；core `dist/runtime/methods/mcp.js`。bootstrap 的 official-plugin-definitions 命中为注释。CLI 源及测试亦消费相关导出；重建后须再扫 dist/生成声明以发现实际仍旧名。实际 build/tsconfig 依赖顺序由执行时确认并记录，不能用旧 dist 对源码变更宣称通过。

## LocalServices 内部注入属性

`local-service-properties.patch` / `local-service-patch-plan.json` 给出 5 文件、22 个 AST identifier，逐位置在 `local-service-properties.json`：`zcodeAgentCommandResolver`、`zcodeAgentNativeRuntime`、`zcodeAgentNativeRuntimeResolver`、`zcodeAgentSpawnFallbackCwd` 均为 `createLocalServices` 与 Host/Server 的内部注入配置；Host 读取现有 `msg.agentSpawnFallbackCwd` 并赋给本地选项，传入消息字段必须保持原名。包括声明、属性读写、测试、局部 binding 与 shorthand 同批更名。授权 TS 扫描未发现四名字面字符串；仍须核实 manual 路径、动态访问和 TS 语言服务引用，不能以该扫描宣称没有反射。

两个补丁在基线 `git apply --check` 同时通过；它们均为提案，应用前在最终候选检查 hash、scope、manualReviewPaths 与 basename 变更。具体文件按两个 `*-patch-plan.json` 的 `files` 列表交付。已获主控授权 `packages/desktop/src/shared/armsRumShared.js.map`；未经新增授权不修改其他生成/冻结/历史文件。

## 拟执行验证

- 根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；CLI 各实际包的 build/typecheck 按依赖执行，CLI 单包 `tsc --noEmit` 不代表整个 CLI workspace。
- 根 Vitest 定向：`packages/shared/test/env.test.ts`、`packages/shared/test/runtimeEnv.test.ts`、`packages/desktop/test/desktopRuntimeEnv.test.ts`、`packages/desktop/test/appARMSBootstrap.test.ts`、`packages/desktop/test/desktopStabilityTelemetry.test.ts`、`packages/desktop/test/armsRumShared.test.ts`、`packages/services/test/localServicesRemoteAuthority.test.ts`、`packages/server/test/stdioDesktopPresentationSurface.test.ts`、`packages/desktop/test/cuaNarrowAgentRuntime.test.ts`；以 package 当前 runner 与隔离资源为准。
- CLI bootstrap 的 `mcp-project-config.test.ts`、`telemetry-bootstrap.test.ts` 使用该包 `vitest run`；CLI 的 `cli.unit.test.ts` 和 `zcode-cua-plugin-host-authority.node-test.ts` 使用 package 脚本的 `node --disable-warning=DEP0205 --import tsx --test`。新增实际调用测试由符号引用结果扩展，不把静态搜索视作通过。
- 检查 scope 外历史模板、manual fixtures 及生成 map 的相对路径；失败保存原日志，源码修复超出授权先交主控。实际产物与测试尚未运行。

## 实际实施与验证

已应用上述两份补丁：19 个 runtime/env 绑定及 4 个 LocalServices 内部选项；保留 `msg.agentSpawnFallbackCwd`、环境变量/define、遥测和 wire 字符串。46 个产品改动路径及每项 SHA256 见 `output/zody-rename-r20-symbols/batch-next/candidate-file-list.json`，均在授权范围。旧标识源码命中仅当前解释性注释、测试描述及历史/人工路径，仍由 R20.5 逐项归属。

生成物：隔离 config `batch-next/emit/tsconfig.json` 继承 Desktop main，以最小文件、DOM lib 与 shared reference 输出。首次 emit 因 shared 旧声明缺新导出失败（`companion-emit.log`，exit 2）；`pnpm exec tsc -b packages/shared` 退出 0 后重试成功（`shared-build.log`、`companion-emit-retry.log`）。真实 emit 的 JS 与 `.js.map` 复制到已授权位置，map 的 `sources=["armsRumShared.ts"]`；d.ts 和其 map 生成结果与现有一致。SHA256：源码 `f280deb7e2e5f2d8e0c1bc28ad8c6df9d1c3b499d12d1e105ad0c5d59bd85b1a`；JS `632e6a3068ff46fcd32c5aa828cbef7340125a4629b7ea45213d668a98e92893`；JS map `0dd3529fea8306145102ceac5e7abb24b72f9229e2c2bb31d4ef32326583e485`；隔离 config `d3b99dba498fee8d168d6ce5d3a425e4fb5af941ec6993376eac11d402950cf1`。

工作区根依次隔离旧 dist 并运行 `pnpm --dir apps/zody-cli/packages/core build`、`pnpm --dir apps/zody-cli/packages/adapters build`、`pnpm --dir apps/zody-cli/packages/bootstrap build`，均 exit 0；随后 `pnpm --dir apps/zody-cli/packages/cli build` 0。旧 dist 备份和各 build log 在 batch-next 下；新 dist 扫描旧名仅命中 bootstrap official-plugin-definitions 的解释注释，不添加旧 export。

工作区根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 均 0（lint 303 warnings），`pnpm --dir apps/zody-cli/packages/cli exec tsc --noEmit` 0，后者只覆盖 CLI 包。`root-target.log` 中九个指定根测试文件 143/143；bootstrap 包 cwd 的两 Vitest 文件 19/19；CLI 包 cwd 的两 node:test 文件 176/176；Core 包 `pnpm --dir apps/zody-cli/packages/core exec vitest run tests/mcp-tool-bridge.test.ts` 38/38。全部完整输出及退出码见 batch-next 下对应日志，未安装依赖。

Desktop main 的 `pnpm exec tsc -b packages/desktop/tsconfig.main.json` 仍 exit 1，85 条诊断；与先前已独立核实的 854 基线按文件、行、列、错误代码比较 0 新增/0 消失，三条完整文本仅 union 成员顺序不同。完整差异在 `desktop-main-comparison.log`；不能称该配置通过。
