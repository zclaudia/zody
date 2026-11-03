# R20.5 当前文字预检

固定提交 `2d9e7d39`，只读产品源码与现行 scope。`output/zody-rename-r20-current-text/current-symbol-text.patch` 包含 42 个授权文件、69 个候选文字位置：55 个已迁移内部标识的当前注释/测试标题，14 个开发文档中面向读者的 Zody 品牌展示。每个文件前后 SHA-256、逐位置旧/新文本和 15 个暂缓项在 `candidate-plan.json`；补丁 SHA-256 `d9d786c99e869e5eb2e0e06d127733ed0d4125f6d166d9b6c5f07813f188193d`，对隔离快照 `git apply --check` 通过。它不是已实施结果，应用前须重算基线并逐项复核语义。

scope 中已登记的 `ZCodeAgentRuntimeRestartedEvent` 当前注释及三个旧函数 describe 名称均在候选内。`apps/dev-docs/src/data/protocolDocs.ts:799` 的 `{ name: 'ZCode Protocol'; version: 1 }` 是可能的协议值示例，未改；`:404` 的 `ZCodeSessionSendParams` 也未证明当前类型来源，暂不更改。外部作者署名、`Modified by ZCode`、来源与历史/冻结证据、兼容 `Error.name` 和其断言不做机械替换；含过去、旧、上游等上下文的 15 条候选保留人工审查。

`ownership-screen.json` 对受控搜索命中的 33,618 行按文件、行号给出初步任务归属，其中环境/define 交 R30，握手/代际与 wire 交 R40–R43，实际错误或持久身份交对应合同 owner，遥测交 R45，插件外部身份/格式与 hook 来源分别交 R54/R55。字符串有多种用途，屏幕仅按行启发式路由，**不是逐条语义结论或完整验收**；例如 `ZCODE_` 命中仍须区分环境变量、define 和其他键，用户可见品牌与外部错误值必须分开。源码标识、运行时对象键、协议/序列化值、第三方模板和历史归档均不能依此做全局替换。

候选与 runtime B/C 预览在 14 个文件重叠，精确清单为 `runtime-overlap.json`。R21_links 完成绑定候选后，由唯一写者先固定结果，再重新读取每个文件并重算候选及 SHA；不要让旧补丁覆盖 runtime 改动。对本批候选应用后建议执行 `pnpm exec oxfmt --check <候选文件>`、`pnpm exec vitest run packages/services/test/zodyAgentProcessManager.test.ts packages/shared/test/env.test.ts packages/shared/test/zodyProtocolV4WorkspaceConfig.test.ts`，以及 `pnpm --dir apps/dev-docs exec vitest run`；代码注释和展示文本无行为变更，仍须按实际脚本与所选文件检查结果如实记录。本预检未执行这些测试、构建或安装。

限制：本次 grep 排除了明确的 native/frozen、fixture 和执行台账，未读取真实用户数据；33,618 行为粗筛命中而非已逐条处置项。AST 提取只覆盖已登记迁移符号的普通注释及 `it`/`test`/`describe` 直接字符串，未覆盖动态模板、所有测试封装或尚未迁移的 runtime 名称。剩余当前文档/诊断及其他命中仍需逐条确认 owner，不能把这份预览称为 R20.5 全量完成。

## 21c 固定源码的最终候选预检

以 `21c06e804020be17dc4dde62fbc0ee4d2b96beb4` 从 Git 读取固定字节，没有读取或覆盖 R01 正在修改的产品文件。`output/zody-rename-r20-current-text/final-preflight/candidate.patch` 是隔离候选，SHA-256 `5ec9fc2e2382d462a7c7f507940b31bf025abf08613c0d3ff368d10525377604`；对对应固定快照执行 `git apply --check` 成功。`candidate.json` 列 78 文件 before/after SHA 和每项精确文字；其中原 69 项有 9 条保留 `ZCode Protocol`，因为 `packages/shared/src/zody-protocol/index.ts` 的 `ZCODE_PROTOCOL_NAME` 当前值正是该 wire 名称，不能改成 Zody Protocol。其余旧候选 60 个文字位置重基成功，另纳入 41 个已完成内部符号注释/标题、17 个当前内部 package/CLI 引用、10 个真实移动后源码路径。该计数为候选条目，跨同一文件的条目不是独立语义变更。

7 个 JS 文件形成两个独立内部绑定批：compact `case-utils.mjs` 与 `run.mjs` 的 `loadZCodeModules` → `loadZodyModules`；memory `memory-e2e-runtime.mjs`、`memory-bench.test.mjs`、`memory-bench-child.mjs`、`run.mjs` 的同名但独立绑定及消费者同样改名；`packages/services/test/fixtures/staging-backup-task-readers.mjs` 的独立 schema 声明和本文件引用 `zcodeTaskModeSchema` → `zodyTaskModeSchema`，不是 shared 同名绑定，也不改 schema 值。两个组不改变数据格式或迁移用户状态。

对原 1602 个候选按 21c 固定源码的文件、声明 kind 和名字逐项检查，221 个源文件中每条都找到相应新声明，同文件同 kind 未发现其旧声明；完整记录为 `1602-declaration-audit.json`。这比仅查找新名字更强，但不证明同名其他 kind、动态反射或业务语义自动闭合。额外文字重扫仅覆盖原 `scan-files.json` 的 83 个已授权候选文件，不是对全仓历史命中重新扫描，也不证明所有现行短 token 已分类。`text-owner-table.json` 保存 205 个重扫注释/标题逐项文本和当前归属；剩余明确需要后续精确判断的短 token 包括 9 条可能指当前或旧 executable/path、7 条当前/历史 CLI 语境、2 条短 token，其余属已验证插件 ID、现存历史文档路径、历史语境、service member 批次或当前源路径候选。不得把它们都写成 R20 完成，也不能按 token 机械替换。

`member-overlap.json` 列与 R01 服务成员预检的 12 个潜在重叠文件；R01 完成并冻结后，必须对其真实最终 diff 重算交集，在新提交重基并重算每文件 hash；不得直接将 21c 补丁套进并发改动。`references/zcode-feature-graph.yaml` 当前文件和技能引用不在已完成的 source move 中，作为 R21 单独路径决策，不在本补丁移动或重命名。保留 `ZCodeAgentMcpStatusModeUnsupportedError`、`ZCodeProtocolClientError`、`ZCodeProtocolRequestTimeoutError`、`ZCodeV4CommandRejectedError`、`ZCodeAttachmentFaultError` 的 `Error.name`、ServiceChannels、env、wire、插件 ID、第三方 `Modified by ZCode` 和历史来源。`{ name: 'ZCode Protocol'; version: 1 }` 为当前 wire 示例，保留；`ZCodeSessionSendParams` 文档标题尚需先确认是当前类型引用还是历史协议名称。

后续授权实施先基于 R01 固定提交再核对 patch，按 spec 保持外部字段；建议隔离 HOME/USERPROFILE/TMPDIR 并移除 provider 凭据，运行 compact `pnpm --dir apps/zody-cli exec tsx e2e/compact-microcompact/run.mjs --case=fake`、memory `pnpm --dir apps/zody-cli/e2e/memory run e2e:bench`、`pnpm exec vitest run packages/services/test/tasksDatabaseRollback.test.ts`，再按改动文件运行 dev-docs 和相关测试、根 typecheck/lint/changed architecture。内存 bench 使用脚本化 provider，仍需确认隔离路径和结果。此轮未运行构建、测试、安装、Docker 或产品 fixture，也未将补丁应用至工作树。

## 同行审查后的修订候选

R10 的 `final-preflight/peer-review.md` 指出的两处已在独立 `final-preflight/revision/` 预览修正：automation 注释使用现行 `@zody/shared`；broker 注释准确说明 `listen` 启动后 `ready` 可能尚未完成，`close` 等待 `ready` 再关 server，不再把 `createZodyApp` 称为同步工厂。原 `final-preflight/candidate.patch` 及 SHA 保留；修订版 `revision/candidate.patch` SHA-256 `2fb7cf442dfb41ad3ad636e6e206f7b31d7f584322d4d77f5717674ef59af2e7`，固定 21c snapshot 的 `git apply --check` 成功，78 文件和 12 个 R01 预检潜在重叠不变。

原 18 个泛化短 token 已在 `revision/text-owner-table.json` 逐项决定：当前远端服务端、CLI 与实际 `zody-server-cli` 源路径使用准确产品描述；dist 测试标题写实际入口 `zody.cjs`；远端部署示例的 `~/.zcoder` 更正为当前 `.zody`。保留真实 `zcode-agent` 原生二进制身份（`packages/shared/src/zody-agent-runtime.ts` 的 `resolveEntrySegments` 明确返回该值）、历史 ACP `~/.zcode/v2/sessions` 输入、旧 CLI peer 的兼容说明和测试实际读取的 `data.zcode` 字段。修订差异与理由逐条保存于 `revision/candidate.json` 的 `revisionChanges`，不更改协议值、env、第三方归属或历史数据。

上述是固定 21c 的可审查预览，不是对 R01 当前可变源码的验收。仍须等 R01 完成并固定后，以其实际 diff 和新提交重基、逐文件重算 hash、检查相同 12 个潜在重叠，并执行前述隔离回归；此轮没有应用产品补丁、测试、构建或安装。
