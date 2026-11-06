# R20 运行时符号闭合预检（只读）

固定当前源码 `a8a0fe2b5b168536bfb68d24911ba4368f7d1ff5`，106 个 type/interface 批已实施、仍待独立复审。读 `output/zody-rename-r20-runtime-next/README.md`、`bc-47-triage-aliases.json`、491 条 B/C 预览及全部 `runtime-refined-aliases.json`。不改产品、不安装构建、不操作历史冻结产物。按 prior 857 条记录的声明、已绑定和未解析文件集收敛至 1,422 个现存 TS/TSX 输入，用 TypeScript checker 在当前文件上重绑定：857/857 找到旧运行时声明，760 条在该有限模型内有绑定且无同名未解析，97 条仍有同名未解析（`runtime-closure/rebind.json`）；这不是原项目各 tsconfig 的完整引用证明，更不含 JS/d.ts、字符串反射或全部新发现符号。原 638 条 new-name-found 只表明有名字，未用作已闭合证明。

旧 491 记录、207 文件 B/C `bc-expanded-preview.patch` 当前 `git apply --check` 退出 1，至少 `packages/ui/src/lib/zodySessionProjection.ts`、`apps/zody-cli/packages/bootstrap/src/zody-protocol/workspace-model-runtime.ts` 不匹配；对比 207 个 before SHA，16 文件已改变、0 缺失（`runtime-closure/preview-staleness.json`）。不能直接应用旧 patch 或依赖旧 offset；应在完整冻结基线上基于真实 tsconfig/exports 重算，并重复导出引用、动态调用和碰撞检查。

## 覆盖全集与最少串行语义组

`runtime-closure/plan.json` 列 857 条逐记录新旧声明、当前绑定引用、未解析位置、原 47 项分诊、各自分组、候选/人工标记；去重后 845 个 `(声明文件, 旧名, 声明种类)` 键，重复记录不是额外符号。表中“候选”只是同一模型中绑定解析、原筛选无已知字符串/成员风险、声明文件中未发现新名的**可进入进一步审查**集合，不是已批准自动替换；所有 patch 都须基于真实项目绑定与生产契约复验。

| 串行组 | 覆盖原 857 记录 | 当前去重前绑定文件数 | checker-bound 候选 / 人工核查 | 闭合边界 |
| --- | ---: | ---: | ---: | --- |
| A shared / services / bootstrap | 538 | 269 | 262 / 276 | B/C 原 491 与原额外 47 的真实重绑定；shared 与 bootstrap 协议同源、services 和 UI/测试消费者一起变更 |
| B CLI / provider | 87 | 120 | 40 / 47 | CLI app/credential/config、provider-node 真实导出及依赖注入，包含 type 批修改过的调用方 |
| C UI / other | 178 | 777 | 106 / 72 | store/hooks/UI 属性、动态模块与测试；大量同名局部/未解析噪声，文件数是上界不是写许可 |
| D desktop | 54 | 23 | 27 / 27 | main/host/renderer 声明与测试、preload 外部桥接边界；不可改 IPC/wire 值 |
| E CUA JS/declaration | 另有原清单缺失的 1 个 d.ts 记录 | 明确 3 个活跃源文件起步 | 手工成对 | `packages/zody-cua/broker-server.js:155` + `broker-server.d.ts:211` 的 `isPotentialZCodeCuaAgentMcpServer` 与 `packages/services/src/node.ts:422,677` 同批，核对 package exports、测试和生成产物；不只改 d.ts |

A 与 B 有 18 个绑定文件交集，A/C 14、A/D 6、B/C 6、C/D 1；具体列表见 `plan.json.overlaps`。所以四组**不可并行写**。最少是一个 writer 分 4 个串行有界交付 + E 与相关 consumers 在 A/B 中同批或作为第 5 个串行原子交付；不是按包拆成并行 writer。每批冻结 commit/tree、更新声明/所有调用者与专用回归，再在新基线重绑后进入下一组。排序 A→B→C→D→E 是可执行起点，但实际 E 若与 A 的 CUA 节点共享文件，应并入 A，不能在 A 未闭合时单独发布。整批改名必须同时覆盖跨组同一 API 的静态消费者；若不存在保持编译的中间结果，联合受影响组为同一 writer 原子候选，不允许拆成半成品提交声称完成。

`plan.json` 将 435 条标为模型内 checker-bound 候选、422 条标为语义/绑定人工项（合计 857）；不是 435 个已经安全授权改名的符号。11 条声明文件已有新名文本须查真实 scope/绑定（包括 `packages/services/src/node.ts` 四个 service/syncer 局部与 `zcode` 短名等）；同名出现在不同作用域、注释或类型并不自动等于冲突，也绝不自动判定等价。大量 unresolved 来自短名 `zcode` 和重复名称：不得把全量同名文本作为引用或 blanket 改名；逐条检查 AST identifier 的声明所有权及动态使用。

## 必须同批核对的跨边界位置

- `runZCodeProtocolAgent`：bootstrap 导出、CLI `RunDependencies` 注入、`cua-launch-session.ts` 属性访问和 tests mocks 属内部 API，须核构造/访问并同步；`createZCodeApp`、`listZCodeCustomCommands`、`inspectZCodeCustomCommand`、`listZCodeSkills`、`inspectZCodeSkill` 的动态模块属性访问亦需随真实 module export 更新。`packages/desktop/test/hostDatabaseStartup.test.ts` 中 `resolveZCodeAgentSpawnCwd` mock 导出键和 provider headers tests 动态 `import('@zody/shared')` 解构必须同批，保留 schema 数据字段。
- `resolveZCodeEndpointOrigin` 是 NodeApiClient/TelemetryCore 的内部 DI 成员：options 构造、私有成员、调用、desktop main 和 tests 假实现要一并核对；`resolveRuntimeZCodeEndpointOrigin` 的同名 mock 与局部变量逐条核定。`bc-47-triage-aliases.json` 列 47 条详细字符串及未解析证据，R20 动态 consumer 不能因 491 预览已产生就省略。
- `this.name` 五个运行时值 `ZCodeAgentMcpStatusModeUnsupportedError`、`ZCodeProtocolClientError`、`ZCodeProtocolRequestTimeoutError`、`ZCodeV4CommandRejectedError`、`ZCodeAttachmentFaultError` 及其测试断言按现合同保留，即使 class binding 改名；禁止改变 error code、`ServiceChannels` 字符串、`ZCODE_*` env/define、schema/持久化 key、`window.zcode` 与插件契约值。这些由 R30/R40–R55 对应阶段负责。shorthand 改 binding 时旧外部键保留成 `oldKey: newBinding`；如确认是内部 DI property/mock，则构造者、读取者和测试同批改，不得机械保留或改外部键。
- CUA JS/d.ts 双声明还需确认 `.d.ts` 是维护源、对外出口及 CommonJS/ESM 消费者、宿主与测试；保留 `ZCODE_CUA_HELPER_ADDON` 与 `zcode-cua-windows-dev/v1` 值。tracked native frozen-candidate 与历史证据不可触碰。无 package-wide JS 静态分析替代真实运行时测试。
- 实际 `pnpm dep:refs packages/services/src/node.ts:createZCodeAgentService --json` 退出 0（工具输出在 `runtime-closure/dep-refs-service.json`，pnpm banner 后接 JSON）：41 references、1 re-export；包括 `packages/services/src/node.ts:317,1728` 和多个 `await import(...)` 的测试消费者。位置来自当前源，行号随下批变化。dep-refs 不保证字符串/动态路径/反射完整，示例只是代表性核实；不要把 0 当证明无调用。首次按技能示例 `pnpm -s` 被本机 pnpm 拒绝，改用上述实际命令，未改环境。

## 未决边界与完成条件

当前没有理由要求改动既定外部值；Error.name、ServiceChannels、env/插件/wire 的兼容决定已有阶段 owner，可按保留规则继续。**真正阻碍**是逐项无法判定的 property 是内部 DI key 还是对外序列化字段、跨模块动态/反射 export 是否有不可见消费者、以及 E 的 JS/d.ts/外部分发接口覆盖；这些必须由对应合同 owner 依据真实调用和测试确认，不能凭 `new-name-found` 或旧快照直接推断。若审查显示需改变外部键/身份或构造新的兼容策略，先交主控确认既定阶段合同，不在 R20 自行做产品设计。当前 491 预览与 47 分诊均需重新审定，不能标为全批安全。

每组正式实施：先按 AGENTS 更新对应 spec（涉及状态/时序画 owner/event 顺序），使用实际 TS project/dep-refs + 动态 import/mock 精确搜索，产出 before/after SHA 与每条声明迁移/保留清单，测试先失败后修复；跑受影响包实际单测、协议 desktop continuous / mobile replayable 相关案例、CUA JS/d.ts 类型与 runtime 测试，根 typecheck/lint/architecture，交独立复审。状态字段、ServiceChannels、wire、Error.name 反例须测试。每组后重新扫本批残留及交叉引用；经全部四组和 CUA 闭合、额外新出现声明审计以及最终集成验证后才能称运行时收口。当前报告没有运行测试或生成任何产品 patch。
