# R02 旧独立 server-cli 发行包启动缺陷

2026-11-03；只读分析旧源码 commit `033f91783901e6adaf968d3d4b8ca34c41d89442` 和 R02 隔离产物。未修改旧版或新候选产品源码。

## 已确认的根因与复现

`packages/zcode-server-cli/tsup.config.ts` 对 `src/main.ts` 和 `src/server-core/entry.ts` 生成 `format: ["esm"]` 的 Node bundle，把 `@zcode/services` 内联；外置列表没有 `yazl`。`packages/services/src/feedback/feedbackLogArchive.ts` 静态导入 CommonJS `yazl`，因此编译后的 ESM `runtime/server-cli.js` 将它内联成 `require_yazl()`，其中执行 `__require("fs")`。staging 原样复制两个 bundle 并写 `runtime/package.json` 的 `type: module`；launcher 用包内 Node v22.16.0 直接执行 `server-cli.js`。Node ESM 没有可用的 CommonJS `require`，生成的 `__require` fallback 在模块初始化时抛错。失败发生在 CLI 命令分发和 HTTP 启动前，与代际握手无关。

Linux arm64：此前在无挂载、断网 Docker 容器中构建并运行真实 stage 发行包，两次 `bin/zcode serve --server-root <isolated> --json` 均退出 1，错误 `Dynamic require of "fs" is not supported`，调用栈为 `yazl/index.js` → `feedbackLogArchive.ts` → `services/src/node.ts` → `server-cli.js`。完整日志见 `output/zody-rename-r02/legacy-runtime-linux-server-cli-smoke.log`；发行 tar SHA256 `481126676de7de1feee727b28ef05aaced1a0afee208370e276a6c0fb9a65aaa`。

macOS arm64：将 R02 隔离旧发行目录复制到临时目录，在该目录作为 cwd，以 `sandbox-exec` 禁止网络和 `/Users/zhvala` 的文件读写、空环境（仅 PATH）执行发行 `bin/zcode serve --server-root <临时目录>/data --json`，退出 1，报相同动态 `require("fs")` 和同一 `yazl` 栈；临时目录自动清理。发行 `runtime/server-cli.js` SHA256 `6127a4779b11003cb1f4401a4c37c5e070c0714831ef50c1a0b036e45add89c8`，与该隔离工作树 `dist/server-cli.js` 一致。首次默认拒绝 sandbox 尝试因限制过严退出 134，未用于根因判断；上述允许系统访问、禁止用户目录/网络的复验给出实际错误。

`server-core.js` 也包含同一内联 `yazl` / `__require("fs")`，所以修复 CLI 后 Core 仍需实际启动验证；这是静态证据，当前尚未单独运行该 Core。`packages/server/tsup.config.ts` 已把 `yazl`、`yauzl` 外置，并注释了同类 ESM 内联问题；本次 Linux HTTP 入口已实际启动并返回 server-info，但它是另一套发行入口，不能代替独立 server-cli。

## 已有旧对端与验收边界

在仓库现有 R02 前置报告及相关 server-cli 文档中未发现绑定旧源码 SHA、发行包摘要并证明独立 server-cli 可运行的旧制品；`docs/plans/upstream-v3.16.2-implementation-plan.md` 的历史包测试通过记录并非独立发行启动证据。现有 `packages/zcode-server-cli/test/packaging.test.ts` 使用虚构 bundle 和空壳 Node fixture，覆盖结构，不证明实际发行包可启动。当前 macOS 与 Linux 实物都已失败；未找到未经源码或运行时语义改造、经验证可作为该旧版等价独立发行对端的替代。不要将源码直跑、注入 `require` 的预加载器或异常退出伪装成旧版发行成功或代际拒绝。R48 独立 server-cli 真实混布仍阻塞；其他入口可分别继续验证。

## 新候选修复交接

由后续取得 server-cli 构建/发行所有权的任务，先更新对应 spec 和验收场景，再考虑在候选 `packages/zcode-server-cli/tsup.config.ts` 将 `yazl` 外置，沿用现有 `packages/server` 的 ESM 外置策略；同时检查 `yauzl` 等其他 CommonJS 外置项及两个入口实际 closure。staging 从产物裸模块引用解析生产依赖闭包，须核实真实发行 runtime 带齐 `yazl` 及传递依赖和许可；不要仅修改列表或仅测试 bundle 生成。该建议尚未在候选实施，也不证明只改一项足以消除后续问题。

回归应从干净隔离源码按实际脚本 `pnpm --filter @zcode/server-cli stage` 构建目标平台真实发行包，使用随包 Node/launcher 在临时数据根启动 `serve --server-root <绝对隔离路径> --json`，断言 ready、loopback `/api/server-info`、正常 stop 与无残留子进程，再验证 stage archive 解包后的同样行为；实际 Core 启动必须覆盖，以捕获第二入口的内联依赖。分别在 Linux 和 macOS 目标上运行；不以 mock bundle 的 `packaging.test.ts` 代替该集成 smoke。现有单测命令 `pnpm --filter @zcode/server-cli test` 可补充运行，但仅作为辅助。随后用真实旧/新可运行对端按 R48 矩阵核对业务前代际拒绝和零副作用；旧制品本身起不来时该格保持阻塞。
