# R54 插件 manifest 发现、同步、seed 与安装升级规则

插件 manifest 的目录约定在 1.0 前维持双格式：新格式 `.zody-plugin/plugin.json` 优先，旧格式 `.zcode-plugin/plugin.json` 只作为**缺失时的回退**保留（R30 裁决 `preserve-legacy-discovery`）。`.claude-plugin` → `.codex-plugin` →（skills 链另有 `.cursor-plugin`）的既有相对顺序不变，也不因旧 ZCode 格式在 1.0 退役而删除。发现、同步、组件发现、seed、打包/远端资产与安装升级共用本 spec 的同一优先规则，各 owner 只调用自己既有的读取入口，不另造第二套兼容判断。

```mermaid
flowchart TD
  R["插件根目录"] --> N{"`.zody-plugin/plugin.json` 存在?"}
  N -->|"是"| NP{"可读且合法?"}
  NP -->|"是"| USE["唯一生效 manifest<br/>（不合并任何其他格式字段）"]
  NP -->|"否"| FAIL["按该 owner 既有错误通道失败并可见<br/>（不回退、不合并）"]
  N -->|"缺失"| L{"`.zcode-plugin/plugin.json` 存在?"}
  L -->|"是"| USE2["回退旧格式 manifest"]
  L -->|"缺失"| C["`.claude-plugin` → `.codex-plugin`<br/>（skills 链再后 `.cursor-plugin`）"]
  C --> USE3["命中的首个合法格式"]
```

## S1 发现优先规则

1. `.zody-plugin/plugin.json` 存在时，它是该插件根目录**唯一**的 manifest：不读取、不回退、不合并 `.zcode-plugin` / `.claude-plugin` / `.codex-plugin` 的任何字段。
2. `.zody-plugin/plugin.json` 存在但不可读、不是 JSON 对象、`name` 缺失或不符合插件名规则时，按该 owner 的既有非法语义**失败并可见**（S3 表），不得继续探测其他格式，也不得把旧格式内容当作降级结果。
3. 仅当 `.zody-plugin/plugin.json` **不存在**（ENOENT）时才回退：`.zcode-plugin` → `.claude-plugin` → `.codex-plugin`；skills 祖先遍历链在 `.codex-plugin` 之后再尝试 `.cursor-plugin`。每个 owner 保持其现有相对顺序。
4. “存在性探测”入口（`zip-source.hasPluginManifest`）只回答“插件根是否像一个插件包”，新格式加入探测集合且排在旧格式之前，但探测本身不解析内容；解析在后续加载入口按本规则处理。
5. 旧格式的相对顺序与 1.0 前兼容承诺不变；Claude/Codex/Cursor 兼容不因旧 ZCode 格式退役而删除（`contract-map.md` R54 表）。

## S2 统一入口清单

| 入口                 | 文件                                                                  | 角色              | 本规则的落点                                                                                   |
| -------------------- | --------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| 插件发现/加载        | `apps/zody-cli/packages/adapters/src/plugins/index.ts`                | 解析              | `findManifest`：新 → Z → C → X；命中即返回，非法由 `readManifest` 报 `plugin_manifest_invalid` |
| 市场安装/元数据      | `apps/zody-cli/packages/adapters/src/plugins/marketplace.ts`          | 解析              | `findPluginManifestPath`：新 → Z → C → X；`readPluginManifestFromRoot` 非法即抛错              |
| zip 源探测           | `apps/zody-cli/packages/adapters/src/plugins/zip-source.ts`           | 存在性            | `hasPluginManifest` 加入 `.zody-plugin/plugin.json`，其余探测顺序不变                          |
| skill 别名/祖先遍历  | `apps/zody-cli/packages/adapters/src/skills/index.ts`                 | 解析（祖先上溯）  | `PLUGIN_MANIFEST_RELATIVE_PATHS` 前置新格式；新格式非法终止上溯并发出可见诊断                  |
| 同步（用户插件）     | `packages/services/src/plugin-sync/pluginSyncService.ts`              | 解析              | `PLUGIN_MANIFEST_RELATIVE_PATHS` 前置新格式；读取失败继续、解析失败返回 null（不回退）         |
| 组件发现：skills     | `packages/services/src/skills/skillsService.ts`                       | 解析              | `findPluginManifestPath` 前置新格式；读取/解析失败返回 null                                    |
| 组件发现：commands   | `packages/services/src/commands/commandsService.ts`                   | 解析              | 同上                                                                                           |
| 组件发现：subagents  | `packages/services/src/subagents/subagentsService.ts`                 | 解析              | `PLUGIN_MANIFEST_PATHS` 前置新格式；新格式存在但读取/解析失败即返回 null，不继续旧格式         |
| 设置同步             | `packages/services/src/settings-sync/settingsSyncService.ts`          | 解析              | `findPluginManifestPath` 前置新格式；读取/解析失败返回 null                                    |
| seed（内置插件）     | `apps/zody-cli/packages/bootstrap/src/app/bundled-plugins.ts`         | 解析 + 资产白名单 | 根探测、seed 描述读取、`isSeedUsable` 使用优先级；`includedTopLevelPaths` 加入 `.zody-plugin`  |
| 运行期 manifest 重写 | `apps/zody-cli/packages/bootstrap/src/app/official-plugin-runtime.ts` | 解析 + 写入       | 读当前生效 manifest（优先级），只写 `.zody-plugin/plugin.json`                                 |
| 远端资产清单         | `packages/server/src/remote/zodyAgentOfficialPluginAssets.ts`         | 打包白名单        | `INCLUDED_TOP_LEVEL_PATHS` 加入 `.zody-plugin`；`REQUIRED_RELATIVE_PATHS` 保持 legacy 字节     |
| 远端 dev 部署        | `packages/server/src/remote/zodyAgentDevDeploy.ts`                    | 打包哈希/暂存     | 两处 manifest 判定使用优先级；暂存白名单随资产清单                                             |
| 安装升级（市场）     | adapters marketplace 安装/更新/重装路径                               | 解析              | 复用 `findPluginManifestPath`；安装前校验、版本来源、缓存判定同一优先级                        |

`REQUIRED_RELATIVE_PATHS` 保持 legacy 字节的依据：远端官方插件源资产目前仍是上游旧格式包，要求新格式会把“缺失”误判为残缺；新格式一旦开始分发再另派（预案 §5-O1）。

## S3 新格式非法的可见信号（逐 owner）

| owner                                                                          | 既有错误通道                                                                            | 新格式存在但非法时的行为                                                                    |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| adapters `plugins/index.ts`                                                    | `PluginDiagnostic`（`plugin_manifest_invalid`，severity `error`）                       | 诊断指向新路径，返回 null，不加载该插件                                                     |
| adapters `plugins/marketplace.ts`                                              | `plugin_manifest_invalid` 诊断；加载/校验路径抛错                                       | 诊断/抛错指向新路径，不尝试旧格式                                                           |
| adapters `plugins/zip-source.ts`                                               | 无（存在性探测）                                                                        | 仅影响根目录判定，不解析                                                                    |
| adapters `skills/index.ts`                                                     | `SkillDiagnostic`（复用 `skill_scan_failed`，severity `warning`，`path` 为新 manifest） | 终止该 skill 根的祖先上溯，返回无别名；不继续其他格式、不上溯更高层；每个插件根最多记录一次 |
| services `skills` / `commands` / `subagents` / `settings-sync` / `plugin-sync` | 各入口既有 null/空结果语义                                                              | 返回 null / 空组件集，不回退旧格式、不合并字段                                              |
| bootstrap `bundled-plugins`                                                    | 现有 seed 降级 warn / `isSeedUsable=false`                                              | seed 源根仍可被识别（仅需存在）；重写阶段按 S4 抛错或降级；旧缓存判定为不可用               |
| server `dev deploy`                                                            | 既有 `missing official plugin manifest` 错误                                            | 新格式存在即视为有 manifest；内容非法由加载端按本表处理                                     |

不新增第二套错误类型或诊断 code：`SkillDiagnosticCode` 由 R50 之前的 contracts 冻结，R54 只在既有通道上呈现。

## S4 运行期 manifest 写入与升级

1. `writeOfficialPluginRuntimeManifest` 与 `isOfficialPluginRuntimeManifestCurrent` 的目标路径是 `.zody-plugin/plugin.json`。
2. 渲染源按 S1 读取：新路径存在则读新路径，否则读 `.zcode-plugin/plugin.json`。只有写入目标固定为新路径。
3. 旧 `.zcode-plugin/plugin.json` 字节保留，不清理、不改写；生态清理归 1.0 退役清单（S6）。seed marker `.zody-plugin-seed.json` 机制与内容不变。
4. 升级闭环：已安装缓存的旧 manifest 里持久化了旧隐藏命令 `__zcode-plugin-host`。新版本首跑时：
   - `isOfficialPluginRuntimeManifestCurrent` 读取新路径失败（缺失）→ 判定“非当前”，进入 seed 慢路径；
   - 慢路径在 `isSeedCurrent` 命中时调用 `writeOfficialPluginRuntimeManifest`，以旧 manifest 为渲染源、写入新路径；
   - 发现层按 S1 只读新路径，得到重渲染后的新命令。
     该闭环由 `official-plugin-runtime.test.ts` 与 bootstrap `plugins.test.ts` 的升级用例证明（旧文件字节不变、新路径携带新命令、发现取新路径）。
5. 若缓存目录只读导致新路径写入失败，错误按原有 transient/fatal 语义上抛，不静默丢弃（预案 §2.7-E 的升级触发条件）。

## S5 不变量

- 市场 id 保持 `zcode-plugins-official`；外部 CUA 名保持 `zcode-cua`；签名、来源与安装记录身份不因 manifest 路径改名而改变。
- 不合并 manifest：新格式存在时旧格式字段一律不可见，即使新格式缺少旧格式有的 `mcpServers` / `hooks` / `skills`。
- 组件相对路径、hash 算法、seed marker 版本与缓存目录布局不变。
- 隐藏命令常量 `ZODY_PLUGIN_HOST_COMMAND = "__zody-plugin-host"` 硬切，旧值不设别名（同 `ZODY_DWF_CHILD_COMMAND` / `ZODY_NODE_REPL_CONTROL_FLAG` 先例）；父子进程为同一发行二进制，不承诺跨版本混布。
- `ZCODE_PLUGIN_ROOT/DATA/ID/NAME` 与模板展开归 R55，本 spec 不改。

## S6 退役条款

- 旧格式发现兼容与旧隐藏命令值保留至 1.0 门禁；1.0 前一个 minor 发退役警告。
- 退役清单（旧格式发现、旧命令值、孤儿 `.zcode-plugin/plugin.json` 清理、历史 manifest 读取语义）由 R56 汇总，R54 只登记不删除。

## S7 验收

- 实现级测试矩阵见 `docs/plans/zody-rename-execution/test-map.md` 的 `RENAME-PLUGIN-INSTALL` 行与 `docs/plans/zody-rename-execution/reports/R54.md` §测试矩阵：
  - 仅旧清单：旧格式仍可发现/同步/seed；
  - 新旧并存：取新清单，旧清单字段不可见；
  - 新清单存在但非法：失败且不回退（各 owner 按 S3 通道）；
  - 其他格式相对顺序保持（Z → C → X，skills 链再 `U`）；
  - 安装 → 更新 → 重装；
  - 内置插件首次 seed / seed 复用；
  - 升级首跑：旧命令 manifest 重渲染到新路径且旧字节不变。
- 真实安装/升级/seed 的 GUI E2E（`RENAME-PLUGIN-INSTALL`）由 R56 执行，见 `packages/desktop/test/e2e/plugins/manual-review/pending/zody-rename-plugin-install.test.ts`。
