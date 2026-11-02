# R20.4 batch-04 协议传输类型预检

状态：固定 `d49aecefa7d1c3571bfae69fe4817950654b9298` 的只读预案，尚未应用产品补丁或运行构建/测试。R10 正在迁移剩余 basename；本结果不能直接用于迁移后的候选，必须在写者停止并冻结新 HEAD 后重新映射、重新绑定并从新文件内容生成 patch。

本组以完整的 NDJSON 请求/通知/响应传输类型为边界：shared 中 trace、request ID、request、notification、response、error、message 7 个 erased types；Bootstrap 传输/服务中的 outbound message、post-response batch、outgoing message、message handler、client request options 5 个 erased type/interface；services 的同名但独立 `ZCodeProtocolClientRequestOptions` 1 个 interface。共 13 个声明、12 个名字；Bootstrap 是上述 7 个 shared 类型的消费者，并非另有同名定义。两个 client request options 在不同模块分别解析，不合并状态或类型身份。生产消费端和测试的精确文件、旧新符号、SHA 与绑定数量列于 `output/zody-rename-r20-symbols/batch-04/patch-plan.json`。

从 d49 `git archive` 提取授权 sourceFiles（排除 manualReviewPaths）中 3,127 个 TS 文件至 output 隔离快照，ts-morph 语言服务一次加载快照并通过 source alias 解析 shared/services/CLI；`protocol-bindings.json` 给出逐文件位置和上下文，共 22 个文件、172 个 binding。独立 AST 全位置交叉检查在该快照内无未绑定同名 identifier、无同名字面字符串；已追溯 bootstrap 的 source consumers。`whole-tree-evidence.json` 的固定提交 tracked 全树精确词项检查找到 22 个快照源码文件和 31 个 native 历史证据文件，后者保留字节；不包含 ignored 产物或运行时外部动态数据。

`protocol-snapshot.patch` 仅改类型声明、type reference、import/re-export 中对应 identifier；不改 schema 名称、字段、值、NDJSON wire、env、插件 alias 或历史材料。补丁在隔离快照上 `git apply --check --directory=.../snapshot` 通过；**不得将此补丁直接覆盖到正在移动的新路径**。实际使用 TS project/source alias 的跨包路径映射是隔离工具构造，尚未以最终 workspace/package exports 与重建后的 dist 验证；manualReviewPaths、运行时反射及非 tracked 的调用者不能由本检查排除。

实施交接：等待 R10 写入停止；按最终 scope 的 basename 映射重新运行语言服务与逐位置审计，核查 package exports、全部调用者、重名声明、测试收集和大小写碰撞，产生新候选 patch 后再申请/交接单一写锁。源码更改后重建 shared/services 及受影响 CLI bootstrap 的真实 dist，核实 `.d.ts`/生成 JS 与 source map 生产者，再执行根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、对应 CLI 子包构建/typecheck；根服务协议测试与 bootstrap 的协议、transport、CUA startup 等实际 runner 必须依据最终文件路径选取并记录完整命令与退出码。不得用既有 dist、静态快照或本报告充当测试通过。

## B0/C0 全量 erased-type 候选分类

在同一 d49 快照上扩展原 e79 B0/C0 清单的全部 600 条 type/interface 记录，旧→新文件名由 `git diff -M e79eab7d d49aecef` 映射；补入该提交的 94 个 package/tsconfig 文件以还原 package imports，再在一个 TypeScript Program 内用 checker 的 symbol identity 和 alias 解析引用。`bc-bindings.json` 保留每条声明、逐位置引用与无法绑定位置；源文件仅来自固定快照，未读取并发移动中的工作区源码。

600 条记录的分类：565 条为快照中的绑定候选（包含已单列的 04-A 13 条，另有 552 条）；27 条需人工闭合（6 条类型/值合并记录对应 3 个实际服务 token、20 条含字符串引用、1 条有未绑定引用）；8 条在 d49 已无旧声明，属于前批已迁移项。每个阻塞实体的精确声明、`valueMerged`、字符串或未绑定文件/行在 `bc-erased-plan.json` 的 `manual` 中，不将其归入自动补丁。字符串命中包括 dev-docs 的类型名展示及测试文本，须分别确认语义；类型/值合并的服务 token 须和运行时 DI 绑定一起评估，不能只改 interface 或外部协议。未绑定的 `ZCodeAgentSessionRuntimePreferencesRequest` 位于 Desktop 测试导入链，需在最终项目环境追踪。

`bc-erased-snapshot.patch` 含 04-A 之外的 552 条候选，449 个文件、5,351 个 TypeScript 绑定位置；`bc-erased-plan.json` 列逐声明、文件 SHA 和每项改动数。两个快照补丁同时通过隔离目录 `git apply --check`；使用 UTF-16 编译器坐标处理非 BMP 字符，先前以 Python 字符偏移生成预览失败、未改产品，已纠正。旧→新目标名称在固定提交的 tracked 源中未发现精确词项碰撞（`bc-target-name-collisions.json`），不替代最终工作区的同作用域和大小写检查。快照外人工路径/非源码目标词项审计见 `bc-outside-audit.json`，本次无命中；它不覆盖忽略文件、运行时反射和外部消费者。

为验证批量 checker 引用方法，8 个高引用符号另调用语言服务 `findReferences`，两者逐位置集合一致（`bc-sample-crosscheck.json`）；其他候选不是逐个独立二次解析，不应由此声称运行时全链路已证明。保守地按共享编辑文件建立连通分量，552 条中最大分量为 542 条（`bc-components.json`），不能据此按目录并发写；这只是共享文件交集而非完整语义依赖图。实施时可按真实声明/消费者闭合集合串行拆批，保持公共声明与其实际调用者同批，并把每批重新绑定后的剩余集合交接。

本追加仍是未应用、未构建、未测试的固定基线预案。R10 完成后必须对最终路径、package exports、生成物、manualReviewPaths 和二进制/动态消费者重新审查并重生补丁；不将静态快照的 565 条写成生产代码已安全迁移或验收通过。

### 27 条人工审查补充（固定 d49，路径迁移后须重新绑定）

逐记录声明、真实绑定位置、未解析位置和逐字符串旧/新值见 `output/zody-rename-r20-symbols/batch-04/manual-27-closure.json`。27 条包含 3 个 DI 名称各重复一次、20 条含字符串的声明记录（其中 `ZCodeProvider` 为两个声明），及 1 条未解析声明；不是 27 个独立待定产品契约。

- `IZCodeTaskService`、`IZCodeAgentService`、`IZCodeSessionService` 分别有 111、237、40 个绑定位置，均为同名 interface + `createServiceDescriptor` 值；`services/src/descriptors.ts` 只创建 `{ channelName }`。其 `ServiceChannels.ZCodeTask`、`.ZCodeAgent`、`.ZCodeSession` 当前分别是 `zcode-task`、`zcode-agent`、`zcode-session`，是通道身份，联合改名时保留这些属性和值。各 `*.channelName` 引用是描述符访问，需改绑定名但不改 channel 字符串。`desktop/test/cronHostSessionCreateTelemetry.test.ts:39` 是向 `new Function(...Object.keys(deps))` 注入实际源码引用的参数名，须同批改对象键；`services/test/localServicesRemoteAuthority.test.ts:182,192` 是从 `../src/index.js` 动态导入的解构与本地调用，也须同批改名。它们不应被当作外部 wire 字段。
- 20 条含字符串记录均未发现反射或协议值：`apps/dev-docs/src/data/protocolDocs.ts` 中为现行类型展示及 `path#symbol` 源码定位；仅改符号片段并在 basename 迁移后同步实际路径，保留其他产品字段。`ui/test/gitActionMenuCommitMessageFlow.test.ts:142` 为源码文本断言，随声明改预期；`shared/test/zodyProtocolV4WorkspaceConfig.test.ts:118` 和 `services/test/claudeNativeSessionImportFlow.test.ts:34` 为当前测试标题，随名称更新，保留 legacy snapshot 的实际内容。逐位置修改项在 JSON；活跃 dev-docs 由 R20.5 手工收口并先核对授权，测试与类型同批由 R20.4 执行。
- `ZCodeAgentSessionRuntimePreferencesRequest` 在 `services/src/zody-agent/zcodeAgent.ts:370` 声明，`zcodeAgentService.ts` 直接引用；Desktop `hostRemoteWorkspaceServices.test.ts:33,103` 却从 `@zody/services` 导入/使用，d49 `services/src/index.ts` 并未导出此类型，因此 checker 无法解析这两处。建议同批在已有 `./zody-agent/zcodeAgent.js` 类型导出列表新增改名后的明确 type re-export，连同声明、6 个已绑定位置和测试两处一起处理；不可依靠旧 dist 声明冒充闭合。需在最新 basename 后重算及验证公开入口、Desktop 测试编译。

本补充为逐位置实施清单，不是已应用 patch；未运行测试、构建或修改产品。须在最新基线重新计算绑定、逐个审查作用域/命名碰撞，并合并 04-A、bulk 与本补充后生成单一补丁；字符串包含的原路径须结合 basename 清单核对，不得原样覆盖新文件。当前注释中的服务类型名也应随内部声明更新，历史记录和外部契约值保持原样。

### 27 条补充补丁与合并静态检查

`manual-result.patch` 已将 27 条逐位置清单落成差异：351 个文件、2,134 处去重编辑，包含三个 interface/const 联合改名、动态导入解构与动态函数注入键、当前 dev-docs/测试字符串、Desktop 未解析测试的两处引用和 `services/src/index.ts` 的类型重导出。`manual-result-files.json` 是精确文件集；描述符继续使用原 `ServiceChannels`，没有添加旧名别名或额外类型定义。

`combined-result.patch` 将 04-A、552 个额外可绑定候选和上述补充按原始快照位置合成一次编辑，包含 695 个文件、7,657 处去重编辑；精确文件集在 `combined-result-files.json`。原独立补丁有重叠文件/上下文，应使用合成结果核验，不假定可逐个串行应用。两份补丁均对 d49 隔离快照通过 `git apply --check --directory=output/zody-rename-r20-symbols/batch-04/snapshot`；该检查只验证补丁上下文，并不证明编译、运行或最终迁移后的绑定正确。生成脚本 `make-manual-closure.mjs` 对每处旧文本和同位置冲突进行校验；最终 N 基线冻结后仍须重新绑定、映射新 basename 并重新生成，再按授权集合审查，不能直接将 d49 补丁应用到产品工作树。本轮未运行测试或构建、未写产品。
