# Zody 全面分叉:zcode→zody 改名影响盘点与实施方案

状态:调查完成(2026-10-31),实施待批准。2026-10-31 修订:插件生态裁决为适配器方案(§5)。本文以**全面分叉**(不再按功能移植上游 zai-org/ZCode)为前提,推翻 [zody-brand-residual-cleanup.md](../specs/zody-brand-residual-cleanup.md)(2026-10-21)中"保留内部 workspace 标识"的决策;实施前必须先更新该 spec 与 [upstream-sync-policy.md](../docs/fork/upstream-sync-policy.md)。

调查方式:六个并行只读子代理分别扫描 workspace 结构、引用分布、运行时协议、环境变量/对外入口、插件生态、测试/CUA 冻结链,本文为汇总。

## 0. 结论速览

| 层 | 规模 | 风险 | 建议 |
| --- | --- | --- | --- |
| 包 scope `@zcode/*`→`@zody/*` | 46+4 个包名,约 **6180 处**功能字符串 | 低(纯机械,编译器兜底) | 改 |
| 目录名(`apps/zcode-cli` 等 11 个) | 硬编码引用约 **210 处**(集中在构建/打包脚本) | 中(断的是构建链,不是 src) | 改 |
| `zcode-protocol`/`-v4` 模块目录名 | **879 处** import + 2 处副本 + exports 键 | 低 | 改(与 scope 同批) |
| `ZCODE_*` 环境变量 + `__ZCODE_*__` define | 真实读取约 **200 个**变量 | 中(README 公开文档化的 7 个需别名期) | 改,B 组带兼容读 |
| 运行时契约(URI/IPC/握手/遥测) | 151+7 IPC 通道、`zcode-artifact://` 等 | **高**(持久化数据/对端/看板) | 分批,数据迁移 |
| 插件生态兼容面 | 市场 id、iframe API、manifest 格式 | **高**(第三方插件契约) | **适配器**:2 项保留 + 双命名空间 compat 层(见 §5) |
| CUA 冻结链 | 18 处硬编码 + 整链重做 | 中(工序长但已文档化) | 最后批次,一次走完 |
| 测试面 | 1564/2922 测试文件含 zcode 标识 | 低(大头可脚本化) | 随各批机械替换 |

总原则:**插件生态走适配器(外部 id 保留 + 双命名空间 compat 层、带退役策略),产品内部标识全面 zody 化,持久化契约带迁移,冻结链最后重走。**

## 1. Workspace 与包身份

### 1.1 包名(50 个)

- `@zcode/` scoped 包 **46 个**:apps/zcode-cli 下 29 个(adapters/bootstrap/core/cli/contracts/tui/i18n/telemetry/node-repl-host/各 plugin…)、packages/ 下 17 个(shared/rpc/services/ui/desktop/web/server/client/provider/provider-node/zcode-cua…)。
- 非 scoped 含 zcode 的 **4 个**:`zcode-cli`(apps 主体)、3 个 e2e fixture 包(`zcode-*-e2e`)。
- 双重 zcode:`@zcode/zcode-cua`、`@zcode/zcode-cua-plugin`、`@zcode/zcode-guide-plugin`。
- 附加身份:`packages/zcode-server-cli/package.json` 的 `bin: { "zcode": ... }`(private 包,不发布 npm,无外部影响)。

### 1.2 workspace/lockfile

- `pnpm-workspace.yaml`:3 行 glob 含 `apps/zcode-cli`。
- `pnpm-lock.yaml`(v9):importer 键 37 处路径前缀 + 92 处 `@zcode/` workspace 链接键;scope/目录改名后**整体重新生成**(pnpm 自动,diff 巨大但无需手编)。
- 根 `package.json`:name 已是 `zody`,但约 25 处脚本引用 `@zcode/*` filter、`pnpm --dir apps/zcode-cli`、`build:zcode`/`build:zody` 双别名指向 `scripts/build-zcode.mjs`。

### 1.3 git 追踪的 zcode 目录(11 个)

`apps/zcode-cli`、`apps/zcode-cli/packages/{zcode-cua-plugin,zcode-guide-plugin}`、`packages/{zcode-cua,zcode-server-cli}`、`packages/services/src/{zcode-agent,zcode-session}`、`packages/shared/src/{zcode-protocol,zcode-protocol-v4}`、`scripts/zcode-distribution`、`.agents/skills/zcode-large-task-fixture`。

### 1.4 构建与治理配置的隐性耦合(改名漏改不报错、直接失效或静默扩权)

| 配置 | 耦合点 | 失效形态 |
| --- | --- | --- |
| `.oxlintrc.json` | ignorePatterns 含 `apps/zcode-cli` | **静默失效**:改名后整个 CLI 子树突然进入 lint 范围 |
| `architecture-policy.yaml` | 模块 id `zcode-cli`/`zcode-server-cli` + roots 8 处 | `architecture:check` 直接失败 |
| `apps/zcode-cli/turbo.json` | task 键按 `@zcode/*` 包名键控 7 处;inputs 硬编码 `config/provider/zcode-builtin*.json` | 构建图断裂 |
| `config/provider/zcode-builtin.json` | 被 turbo inputs、tsup define `__ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__`(×2)、electron-builder 复制、`packages/provider-node/src/zcode-builtin-release.ts` 四条链引用 | **最隐蔽耦合点**,需沿 define 追到运行时读取处 |
| `packages/desktop/tsconfig.e2e.json` | 全仓唯一 TS paths 别名 `@zcode/e2e-report` | typecheck 失败 |
| tsup noExternal(×3 配置)/vite define | 全部 `@zcode/*` 依赖列表 + `__ZCODE_*__` define 家族 | 打包内容缺失 |
| `pnpm-lock.yaml` / `third-party/inventory.json` | 生成物 | 重装/重建再生 |
| `.github/workflows/zody-release.yml` | 12 处:`pnpm --dir apps/zcode-cli`×3、`scripts/zcode-distribution/*.mjs`×6、`ZCODE_ENV`/`ZCODE_ENABLE_MAC_SIGN` | CI 断 |
| `mise.toml` | `[tasks.dev]` 设 `ZCODE_DATA_BASE_DIR` | dev 环境变量名跟批改 |
| `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml` | **约 1000+ 行路径数据** | 改名后整图失准,需再生成 |

## 2. 引用面统计(@zcode/ 与目录路径)

### 2.1 `@zcode/` 引用(按所在包)

总量 8211 处(git 追踪,含 docs);**真实机械改动约 6180 处**:

| 形态 | 次数 |
| --- | --- |
| 静态 import/export | 5584 |
| 动态 `import()` | 181 |
| `vi.mock/jest.mock` | 29 |
| 代码内字符串(tsup externals/esbuild alias/SEA 包名表/部署清单) | 204 |
| JSON(package.json deps、turbo 任务键、根脚本) | 182 |

分布:apps/zcode-cli 2968、packages/ui 1761、desktop 990、services 548、server 192(前五占 ~80%)。被引最多:`@zcode/shared` 3362、`@zcode/contracts` 1375。

### 2.2 目录路径硬编码(改名即断,已逐条核实)

- **`apps/zcode-cli`**:功能引用约 185 处,核心在构建/打包链:
  - 仓库脚本:`scripts/prepare-prebuilds.mjs`(15+2 处插件路径表/turbo dir)、`build-desktop-agent-cli.mjs`×6、`build-zcode.mjs`×4、`bootstrap.mjs`、`third-party-npm.mjs`、`audit-*`×2 等;
  - desktop 脚本:`prepare-agent-node-bundle.mjs`(17 个插件路径表)、`stage-agent-bundle.mjs`(AGENT_BUNDLE_SOURCE_RELATIVE=`apps/zcode-cli/packages/cli/dist/zcode.cjs`)、`gen-ui-*`、`mcp-apps-host-e2e`、`ttft-otlp-receiver`;
  - 运行时代码 3 处:`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:451,474`(findUpward 找 `apps/zcode-cli/packages/cli/dist/zcode.cjs`)、`packages/server/src/remote/zcodeAgentDevDeploy.ts:109,281`、`packages/zcode-server-cli/src/packaging/stageCli.ts:109,142,198`;
  - 配置:pnpm-workspace、根 package.json×4、CI×3、architecture-policy、.prettierignore/.oxfmtrc/.oxlintrc、Dockerfile×2、wdio.conf(ZCODE_CLI_ENTRYPOINT)。
- **`packages/zcode-server-cli`**:9 处功能引用(根 typecheck、architecture-policy、vitest exclude、构建测试)。
- **`packages/zcode-cua`**:目录本体引用极少(workspace 靠 glob);但包名 `@zcode/zcode-cua` 以 node_modules 路径段硬编码在 4 个 desktop 脚本 + 3 个测试 + electron-builder 深 import(`@zcode/zcode-cua/broker/helperConstants`)。
- **`scripts/zcode-distribution`**:CI 6 处 + `build-zcode.mjs` 5 处 + 混名测试对(`scripts/zody-distribution.test.mjs` 从 `./zcode-distribution/` import)。

⚠️ **勿混**:`zcode-cua` 作为 **MCP server 名/外部 PyPI 包名**有 250+ 处(`packages/shared/src/mcp.ts:228-249` 匹配器、`LEGACY_CUA_PLUGIN_ID`),这是产品能力标识不是路径,**不在改名范围**,动了会破坏 MCP 匹配与用户存量配置。

### 2.3 `zcode-protocol`/`zcode-protocol-v4` 模块目录(第二触面)

- 两处副本:`packages/shared/src/{zcode-protocol,zcode-protocol-v4}` 与 `apps/zcode-cli/packages/bootstrap/src/{...}`(bootstrap 自带),共 ~189 个 ts 文件;
- import **879 处**:`@zcode/shared/zcode-protocol-v4` 子路径导出 497 处(ui 295 文件为最大户)、相对路径 347 处、字面路径串 ~20 处;
- 连带:`packages/shared/package.json` 的 `./zcode-protocol-v4` **exports 键**、`apps/zcode-cli/packages/cli/scripts/build.mjs:149-151` esbuild alias、dev-docs protocolDocs 数据;
- 另有 `packages/services/src/{zcode-agent,zcode-session}` 目录、`zcode-protocol-legacy-types.ts`、`zcode-protocol-entrypoint.ts`、`zcodeEndpoint.ts`/`zcodeEndpointOrigin` 字段(见 §4)。

## 3. 运行时协议与桥接面

### 3.1 分级清单

**纯仓内原子可改(低风险,两端同仓同装):**
- 主 renderer 桥 `window.zcode`(`packages/desktop/src/preload/index.ts:252` 单点暴露 + `packages/client/src/globals.d.ts` 类型;26 文件 186 处消费,已收敛到 desktopPlatform 适配层);
- `zcode:*` IPC 通道 **151 个**(PlatformChannels)+ 7 个(InternalChannels)——两端同版本;
- `__zcodeRpcControl` 控制帧字段(`packages/rpc/src/protocol.ts`)、`zcode-media`/`zcode-browser-restore://` 进程内 scheme;
- `__zcode*E2E` 调试全局(7 个,需同步 e2e 断言);
- 漏网修复:`zcode-endpoint-submit:`/`zcode-endpoint-cancel` 页内 title 通道(`desktopCommandHandlers.ts:252-311`)、`interfaceMode.ts` 旧键注释与读键不一致问题。

**跨进程/跨部署契约(已裁决:随 P4 切换并全量重部署远端,切换后禁止新旧混布,混布即握手失败 fail-closed):**
- `zcode-hello`/`zcode-hello-ack` stdio 握手帧(`packages/shared/src/handshake.ts`);
- `x-zcode-rpc-host-capability` header(desktop↔远端 server)、`x-zcode-intranet-token`;
- `__zcode_rpc_nested_uint8array_v1` 序列化标记——兼作远端 bundle 能力探测(`serverBundleDeployCheck.ts:8`),改名会触发**全量远端重部署判定**。

**持久化数据契约(改名必须带数据迁移,重点):**
- **`zcode-artifact://`**(最高风险):存进历史会话消息 block、workflow artifact ref(`workflow-artifacts.ts:112`,投影时还要重写为 `zcode-artifact://share/:id`);13 处生产代码做 startsWith 判定。已裁决(2026-10-31):**直接切换 `zody-artifact://`,不迁移**——符合 0.1.0 破坏性升级政策,切换日前的旧会话媒体引用失效(含本机 dogfood 会话);
- workspace-hook 信任存储 `workspace-hook-trust-v1.json` 内 `configFileKind` 枚举值 `"zcode.json"`、`".zcode/config.json"`;
- AppSettings 落盘字段名 `zcodeEndpointOrigin`(64 处引用)——改字段名需迁移用户设置;
- 遥测口径:`zcode_protocol.*` 事件名(54 个产生点)、`agent: "zcode-agent"`、`startupKind: "zcode_protocol_agent"`、OTel `zcode.local_ttft.*`/`service.name: zcode-local-ttft`、`zcode.telemetry.schema_version`、`metric_kind: "zcode_data_bytes"`——写进持久日志并上报 ARMS,改名=外部看板口径断代;已裁决(2026-10-31):**接受断代,随 P4 一次性改名**,看板重建,不双发(双发会重复计数污染数据);
- 随发行包固化的资产名:`zcode-provider/zcode-builtin.json`、SEA 前缀 `zcode-tui-runtime/`、`zcode-runtime-tools/`、`zcode-playwright-runtime/`、`agent/zcode.cjs`、`zcode-<platform>-<arch>` SEA 中间产物。

**已确认无 zcode 残留(无需动)**:深链 `zody://`(已迁移)、Electron 分区(全部 zody)、localStorage 键、cookie、SQLite session-store schema、NSIS/Finder/注册表(按 identity 派生)。

### 3.2 MCP 面

已改 zody:clientInfo/clientName、`MCP_APPS_HOST_NAME`、cookie。
仍为 zcode 且属插件契约:见 §5.2 适配层(`zcode/*` _meta 命名空间、`com.zcode/request-context`、`zcode.cua/*` tool-result meta 键——随 tool result 落盘且第三方在读写,过渡期双读双写)。

## 4. 环境变量与对外入口

### 4.1 `ZCODE_*` 分组(真实读取约 200 个;总 token 约 470)

| 组 | 代表变量 | 改名策略 |
| --- | --- | --- |
| A 构建期(~40) | `ZCODE_ENV`(325 处,最高频)、`ZCODE_TARGET_OS/ARCH`、`ZCODE_ENABLE_MAC_SIGN`、`ZCODE_VERSION`、下载镜像族 | 与 CI/mise 同 commit 一次性切换,无需别名 |
| B 运行期公开文档化(**7 个,外部依赖最高**) | `ZCODE_DATA_BASE_DIR`、`ZCODE_SERVER_AUTH_TOKEN`、`ZCODE_BASE_URL`(及变体)、`ZCODE_HTTP_PROXY`/`NO_PROXY`、`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`、`ZCODE_CREDENTIAL_SECRET` | **已裁决(2026-10-31):直接硬切**,只认 `ZODY_*`,不设别名期;`.env.example:2` 与 `README.md:30` 的"保留承诺"声明、mise/CI 脚本同 commit 修改 |
| C 宿主↔子进程内部(~25) | `ZCODE_AGENT_SERVER_*`、`ZCODE_PLUGIN_ROOT`、`ZCODE_DATA_BASE_DIR`(内部管道)、`ZCODE_{BFS,RG,UGREP}_BINARY` | 除 `ZCODE_PLUGIN_*`(插件契约,§5)外可改,两端同版本原子切换 |
| D 测试/E2E(~100+) | `ZCODE_E2E_*`、`ZCODE_TEST_*` 等 | 随测试批机械替换 |

### 4.2 对外命令与分发

- 对外命令唯一是发行包 `zody`(runner 已 zody);`zcode` bin 仅两个 private 包内部使用;SEA 中间产物 `zcode-*` 为内部名。
- 无 npm publish 渠道(全 private),纯 GitHub Releases——二进制层改名成本低。
- CI(唯一 workflow `zody-release.yml`):文件名/任务名已 zody,残留 12 处(见 §1.4);Android 签名已用 `ZODY_ANDROID_*` 新前缀(说明 env 已在向 ZODY_ 演进)。
- 文档同步:必须改的十余个(README×2、.env.example、UI_PLUGIN×2、docs/fork/build.md、docs/zcode-env-consolidation.md、docs/desktop/zcode-preview-packaging.md、AGENTS.md)+ 三个已过时文档(configurable-data-directory.md 仍写 `~/.zcode/v2`、两个 deep-link 文档仍写 `zcode://`);历史 plan/归档 266 文件豁免。

## 5. 插件生态兼容面(适配器方案,2026-10-31 已裁决)

**前提**:Zody 继续消费上游 `zcode-plugins-official` 市场插件(官方 skills/plugins 即装即用)。裁决:不做"整体保留 zcode",改为「**2 项主动保留 + 1 个显式兼容适配层**」——zcode 残留从"散布在协议各处"收敛为"集中在一个带退役策略的 compat 模块",legacy 有边界、可删除。

### 5.1 主动保留的外部标识(不进适配层,无退役计划)

1. **市场 id `zcode-plugins-official`**:外部生态的**地址标识**(类似 registry 名),不是品牌泄漏。上游 manifest `name` 校验(`marketplace.ts:527-546`)、`marketplaces/`+`cache/` 落盘目录名、UI 图标 key 与 `builtinSkillI18n` 路径段匹配、建议提示词里持久化的 `plugin://…@zcode-plugins-official` 引用全部钉在这个字符串上;适配它 = id 映射表 + 持久化引用迁移,复杂度无收益。展示名与逻辑 id 已分离,商店 UI **展示名**照常 Zody 化。
2. **`zcode-cua` MCP server 名/外部 PyPI 包名**(`packages/shared/src/mcp.ts:228-249` 匹配器、`LEGACY_CUA_PLUGIN_ID`):上游产品能力标识,250+ 处,不在改名范围(见 §2.2 ⚠️)。
3. `zcode_mobile_secure_store`(Android 凭据文件名,改名丢已存凭据)。

### 5.2 兼容适配层(双命名空间过渡)

**宿主侧单方面控制的注入面**——双命名空间成本近零,四处实现均有现成先例:

| 面 | 实现 | 先例/说明 |
| --- | --- | --- |
| iframe 桥 | `plugin-sandbox/alias.ts` 以 `window.zody` 为主命名空间注入,`window.zcode` 冻结为只读别名 | 该文件已有 `window.openai` 别名(`openaiAlias.ts`),同一模式第三份;插件 `if (window.zcode)` 宿主检测不破 |
| manifest 发现 | `.zody-plugin/plugin.json` 升为一等格式,`.zcode-plugin/` 降为兼容来源(`PLUGIN_MANIFEST_RELATIVE_PATHS` 及 7 处读取链) | 发现机制本就多格式(`.claude-plugin`/`.codex-plugin` 并存) |
| 页内事件 | 宿主同时 dispatch `zody:*` 与 `zcode:*`(`zcode:globals`/`zcode:set_globals`/`zcode:error`) | `aliasRuntime.ts:73`、`genUi.ts:66,146,191` 两处派发点 |
| 插件 env/模板 | spawn 插件进程时双注入 `ZODY_PLUGIN_ROOT/DATA/ID` + `ZCODE_PLUGIN_*`;`${ZODY_*}`/`${ZCODE_*}` 模板展开都认 | `adapters/src/plugins/mcp.ts:185-195`(已同注 `CLAUDE_PLUGIN_ROOT`,同一做法)、`core/src/hooks/configured-runner-input.ts:95-120`、`bootstrap/src/custom-command-shell-expansion.ts:16` |

**wire 协议(插件↔宿主双向契约)**——需要真正的适配逻辑,不能只改一头:

- **插件→宿主双读**:宿主收到 `zcode/*` 键(`zcode/csp`、`zcode/truncated`、`zcode/widgetState`、`zcode/resourceSubscribe`、`zcode/surface`、方法 `zcode/gen-ui/*`、`com.zcode/request-context`、tool-result `zcode/errorPresentation`、`zcode.cua/*` 元数据)时归一化为内部 zody 形态。归一化**集中在** `packages/shared/src/mcp-apps/contract.ts` 与 `packages/shared/src/gen-ui/contract.ts` 两处定义点,不散到消费点。
- **宿主→插件双写**:过渡期 hostContext 下发与 payload 同时携带 `zody/*` 与 `zcode/*` 键;Zody 新插件用新键,上游插件读旧键照常工作。
- **成本**:过渡期内每个新插件 API 需暴露两份;插件兼容测试矩阵翻倍(上游插件 + zody-native 插件两套)。

### 5.3 退役策略(适配层不得成为永久债)

- 双命名空间维持到**触发点**后,`zcode` 别名整层移除,并按破坏性变更公告。
- 触发点已裁决(2026-10-31):**固定版本 1.0**;1.0 前一个 minor 版本发出"别名将移除"警告。
- 退役前每个 release 的插件兼容验证必须包含**上游官方插件集在 zody 宿主的冒烟**;移除批次需先发一个"别名将移除"的警告版本。
- `zcode-sandbox://` scheme 与 `persist:plugin-sandbox-v2-*` partition 随适配层保留不动(scheme 改名=插件 origin 重置、状态丢失,且对插件不可见,无退役收益)。

## 6. 测试、E2E 与 CUA 冻结链

### 6.1 测试面

- 含 zcode 标识的测试文件 **1564/2922(53%)**:`@zcode/` import 1381 个文件(编译器兜底,可脚本化)、`zcode-protocol` 295、需人工核对的路径断言约 220 个(`apps/zcode-cli` 字面路径 81、`.zcode` 目录 137、`zcode.cjs` 22);
- E2E 录制资产 124 个含 zcode;`.e2e-home/.zcode`、`.zcoder` 是被测 app 自建的遗留目录(非手工 fixture,legacy 读兼容测试覆盖);
- 无 vitest snapshot 文件,无 `.snap` 大面积 diff 风险;
- 密集自测:`cua-desktop-session-bundle.test.mjs`(~20 处)、`tsupChunkIsolation.test.ts`(断言 noExternal 含 `@zcode/*`)、`scripts/test/cli-release`、`builtin-provider-config-build` 等。

### 6.2 CUA 冻结链(高风险工序,必须整链重走)

**18 处硬编码**(核心 5 处):
1. `cua-desktop-session-config.mjs:91` — auxiliary 密封资源源路径 `apps/zcode-cli/packages/node-repl-host/src/server.ts`;
2. `build-cua-desktop-session.mjs:193-197` — cli-entry alias `@zcode/node-repl-host/cua-node-repl-mcp-port`;
3. `cua-desktop-session-workspace-source.mjs:10,53` — workspace 根判定 + `onResolve(/^@zcode\//)` 正则;
4. `cua-desktop-session-bundle.mjs:300-303` — 密封 entry 禁止残留 `from "@zcode/"` 的断言本身;
5. 其余:product-wiring/round11 链 7 处 fixture/evidence/alias 路径、`@zcode/zcode-cua` 身份探测 4 处(computer-use-producer/sharp/windows-helper/electron-builder 深 import)、agent-bundle 邻接 4 处。

**失效机理**:路径/包名改名 → 构建立即失败;改对路径 → sealed entries 字节变 → pins 头 SHA256 变 → Helper 二进制变 → 需沿 round11 冻结证书重签 → 窄 manifest treeSha256 变 → `macos-cua-demo-defaults.mjs` 四个 sha pin 失配 → 归档复检失败 → afterPack 拒绝出包。

**重做工序(依赖顺序)**:18 处硬编码更新 → `build-cua-desktop-session.mjs` 重跑(新 entries+pins 头)→ Helper 重编译+native tests → controller 重签(身份 pins 常量不变,`io.github.zclaudia.zody.cua-helper` bundle id **不动**——它被 DR 字符串钉死,动它=换信任根)→ 窄资源 stage/manifest 重出 → demo-defaults 四 pin 重录 → 冻结归档重导出+`restore-cua-narrow-frozen` 复检 → 主 app 重打包过全部 afterPack 断言。

注意:`packages/desktop/native/macos-cua-*` 六个目录与 `output/cua-*` 全部是 **git 外本地冻结材料**,改名在 git 里看不到 diff,但本地构建链会静默失去输入——重走工序时必须先确认冻结材料在场(用 `restore-cua-narrow-frozen.mjs` 归档机制)。

## 7. 分阶段实施方案

前置:**Phase 0(spec 先行)**——更新 `zody-brand-residual-cleanup.md`(推翻"保留内部标识"决策、固化 §5 适配器方案与 §5.3 退役策略)、`upstream-sync-policy.md`(改为全面分叉:不再常规移植,仅按需安全修复 cherry-pick,接受 diff 面代价)、`zody-path-compatibility.md`(env/键名改名条款)。每批独立可合、可回滚,批内一次提交。

| 批次 | 内容 | 验证 |
| --- | --- | --- |
| P1 低风险清理 | `scripts/zcode-distribution/`→`zody-distribution`(CI 6 处+build-zcode 5 处同步)、17 个 zcode 命名脚本文件、三个过时文档修正(`zcode-endpoint-submit/cancel` 漏网已随 endpoint 字段改名提前完成,2026-10-31) | lint/typecheck/architecture、CI dry-run |
| P2 包 scope+目录(最大批) | `@zcode/*`→`@zody/*`(50 包名+6180 引用)、`apps/zcode-cli`→`apps/zody-cli` 等 11 目录、`zcode-protocol*` 目录名(879 import+exports 键)、§1.4 全部配置、lockfile 再生、feature-graph.yaml 再生成 | 全量 typecheck/lint/architecture/knip、test:unit、build:zody 全目标、e2e 冒烟 |
| P3 环境变量 | A/C/D 组一次性 `ZCODE_*`→`ZODY_*`(C 组中插件契约除外);B 组 7 个**直接硬切**只认 `ZODY_*`(已裁决,不设别名期),README/.env.example"保留承诺"声明、mise、CI 同 commit;`__ZCODE_*__` define 家族随 P2/P3 同批 | env 切换单测(旧名不生效)、CI、mise 任务、.env.example |
| P4 运行时契约 | `window.zcode` 主桥、151+7 IPC 通道、`__zcodeRpcControl`、`zcode-artifact://`→`zody-artifact://`(**直接切换不迁移**,已裁决)、握手帧/能力 header(已裁决:本批切换并**全量重部署远端**,此后禁止混布)、遥测口径一次性改名(已裁决接受断代,看板重建)。~~`zcodeEndpointOrigin` 字段改名~~ **已提前完成(2026-10-31)**:字段改名 `zodyEndpointOrigin` + 旧值随 zod 剥离静默丢弃(production 构建本就写不进该字段,零存量)、配套 title 通道 `zcode-endpoint-submit/cancel`→`zody-endpoint-*` 同批完成;`zcode-builtin` 家族的 `ZCodeBuiltinCachePathOptions.zcodeEndpointOrigin` 属性**不在本次范围**,随 zcode-builtin 批次统一改 | 协议双端联调、远端全量重部署回归、遥测新口径验证 |
| P4.5 插件兼容适配层 | §5.2 双命名空间:iframe 桥 `window.zody` 主 + `zcode` 只读别名、`.zody-plugin` 一等 manifest、事件双发、env 双注入、MCP `zcode/*` 双读双写(归一化集中 contract.ts);§5.3 退役策略随 P0 入 spec | 上游官方插件集在 zody 宿主的兼容冒烟、双命名空间单测(zcode 键归一化/双写)、plugin sandbox e2e |
| P5 CUA 冻结链 | §6.2 十八处+整链重做(重构建→重签→重 pin→归档→重打包) | narrow 全套测试、restore 演练、bundle afterPack 断言、真实截图冒烟 |

顺序依据:P2 必须先于 P3(define 名随包名)、P4 依赖 P2(模块名稳定后改契约)、P5 最后(sealed entries 吸收全部前序改动,一次重走)。

## 8. 决策点(全部已裁决,2026-10-31 用户逐项确认)

1. **插件生态**:适配器方案(§5)。**退役触发点:固定版本 1.0**,1.0 前一个 minor 版本发"别名将移除"警告(§5.3)。
2. **B 组环境变量**:**直接硬切**,只认 `ZODY_*`,不设别名期;README/.env.example 的"保留承诺"声明、mise、CI 同 commit 修改。
3. **遥测口径**:**接受断代**,`zcode_protocol.*`/`zcode-agent`/`zcode.local_ttft.*` 等随 P4 一次性改名,看板重建,不双发。
4. **`zcode-artifact://`**:**直接切换 `zody-artifact://`,不迁移**;切换日前旧会话媒体引用失效(含本机 dogfood 会话)。
5. **远端部署**:**随 P4 切换握手帧/能力 header 并全量重部署远端**,此后禁止新旧混布(混布握手 fail-closed)。
6. **CUA 信任根**:**确认永久不动**——`io.github.zclaudia.zody.cua-helper` bundle id、证书 leaf/DR、Node CDHash(当前已是 zody 命名,仅组织名 zclaudia 保留);动它=换信任根,需重走证书安装与 TCC 归属,零收益。

## 9. 工作量量级(粗估)

- P2 是绝对大头:50 包名 × ~6180 引用可脚本化(codemod + 编译器验证),但 210 处目录硬编码与 §1.4 配置耦合需人工核对;测试面 53% 文件受波及(1381 个纯 import 可自动)。
- P5 工序最长但路径已完全文档化(本仓 10 月各轮已演练过全链)。
- 全程预计需要一个相对干净的窗口(未提交工作流落定后),P2/P5 各占用一个独立变更单元。
