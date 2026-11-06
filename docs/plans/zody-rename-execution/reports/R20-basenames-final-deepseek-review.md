# Remaining98 basename: DeepSeek review

Reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19ccf-8092-7d11-9010-8010e395f2a5`; route `deepseek-flash`, provider `magpie`, model `group/deepseek`; read-only.

Fixed diff: `d49aecefa7d1c3571bfae69fe4817950654b9298` → `f28dfddcbd4e646d7fa93d2e593b91a62063b2b6`.

**结论：PASS（限定“剩余 98 basename / 342 文件”范围）**
- 本批 98 个移动、244 个消费者与两份当前文档、审计四处正则、R21 图路径收口均在固定候选 `f28dfddc` 内闭合。
- 不等于 R20.4/P2、Desktop 干净构建或全仓旧路径清零。

**静态核查（git show/git diff 固定 SHA）**
- 父提交正确；98 个移动全部同目录、无目标碰撞/大小写碰撞；198 条登记移动在候选上旧路径全不存在、新路径全存在。
- 342 个当前候选文件与 diff 一致；另 15 个为计划/报告/ledger/graph，均在授权范围；`manual151` 交集为 0，preflight `outsideAllAuthorizedSets=[]`。
- 244 个消费者逐行归因：除 4 个已审定例外（resolver 新测试、audit 正则、settings 文档、active native entry）外，全部只是旧→新 basename 路径字面替换。98 个移动文件按 198 映射做路径归一后与 base 逐字节相同；无 env/wire/序列化值、外部 Excalidraw/marketplace/MCP 身份变化；锁、inventory、native/frozen 未动（仅授权 active entry 的 import 路径）。
- 构建/入口消费者已闭合：`vitest.config.ts`、CLI `package.json` 测试列表、`desktop-main-entrypoints.mjs`、Worker URL、`@zody/shared/zodyEndpoint` 导出 + CLI build alias + 两个 vite 配置、`official-refs-baseline.json`、`download-glm.*`、`prepare-prebuilds.mjs`。
- audit：四处精确正则（runtime-blocker 2、compat-type 2）与 policy 修复保留，分类断言正确。
- E2E：spec 为 100% 纯移动；新 resolver 测试与 helper 实现一致（旧 fixture 仅作拒绝输入，无旧名回退；strict 缺新 fixture/manifest 会抛 `workspace-zodyignore`；manual 缺 case-local 走 capture）。
- R21 图：仅 23 处/13 路径替换；解析后 372 节点/726 边；按路径归一后与 d49 深度相等。
- 两份当前文档仅路径替换；历史设计文档/计划记录未被改写。

**非阻断残留（需后续 owner，非本批引入）**
- `scripts/audit-zody-agent-remnants.mjs:99` 的 `zcodeSessionStore` 正则未改；因前面的 `/^packages/ui/src\//` 宽规则先命中，当前分类不受影响，但属死正则，建议随后清理为 `zodySessionStore`。
- 既有目录改名残留（d49 已存在，未在 342 内）：`v4-native-boundary.test.ts:14`（读不存在的 `src/zcode-protocol-v4/`）、`v4-native-selection-side-chat.test.ts:13`（mock 不存在路径）、`conversation-topic-publisher-hydration-bound.test.ts:25`（`@zody/shared/zcode-protocol-v4` 无 export）、`apps/zody-cli/scripts/shadow-replay.mjs:35-36`（旧 dist 目录）。若主控要声明“全仓所有路径消费者清零”，这些必须先登记/修复；不应把它们算作本批已闭合。
- basename-03 ledger 仍 `candidate:null`、pending review；报告“尚未提交”为提交前措辞，属回填事项。

**实际执行证据（我未运行，仅读主控/Terra 输出）**
- root 119 文件：1815 pass / 1 fail / 1 skip；唯一失败为 `providerRevision` 扫描，d49 未打补丁快照同样 4 命中，属基线失败。
- CLI 126 + Node 2、dev-docs 4（图修复后）通过；typecheck 0 error；lint 303 warnings/0 errors；changed architecture 0 violations；Main 85 条诊断按路径/union 顺序归一与旧基线整份相同；59 模块/235 输出对新存在旧不存在。
- WDIO 配置加载意外触发 Electron `install.js`；342 文件与 649 manifests/locks 匹配预期，但无 node_modules 前后清单，不能声称无 install 或干净发行验证。
- Desktop `out/main` 未清理、CUA manifest 缺失、原生 E2E 未跑；这些仍是 R22/R60/后续门禁。
