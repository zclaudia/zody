# Independent standalone ESM bridge review

DeepSeek A, fixed7089 source. Scoped PASS with no changes required. Original behavioral red used the earlier shared-dist test; final isolated-output test was separately verified green, and real staged smoke is separate evidence. Raw receipt follows.

**结论**
`scopedPASS`。固定提交 `7089ad3e095ec10727772107100d3e019b78d456`（tree `1ead5e11…`，父 `6fb79b35…`）中的独立 server-cli ESM 兼容桥在本次限定范围内实现正确；未发现阻断 R01/R02/R10 继续的缺陷。以下结论不扩展为完整 R22、发行、签名或其他平台通过。

**独立核验**
- 差异确为 3 个产品/spec/test 文件加 6 个报告/账本文件；未改 external/stage/deps/lock/define/env/protocol。三文件实际 SHA 与 `change-hashes.json` 逐一一致：`d1fe0d7a…→88f0100f…`、test `66702d40…`、spec `24cd7e47…→df34dcde…`。
- 两个 bundle 共用 banner，显式建立 `createRequire(import.meta.url)`；只把私有 `__zcode*` banner 绑定精确改为 `__zody*`，未改变内联布局。见 `packages/zody-server-cli/tsup.config.ts:27`。
- 新测试实际调用已声明的 tsup bin、使用临时 outDir 和隔离 HOME/TMP/XDG；AST guard 检查两个入口的 `require`/`__require` 声明、字面调用、计算目标和别名逃逸，并对非 builtin、计算、逃逸做负例。见 `packages/zody-server-cli/test/packagedRuntimeSmoke.test.ts:34`、`:127`、`:178`、`:195`。
- 红证 `red-scoped.log` 保留真实 `Dynamic require of "fs" is not supported` 和 `yazl` 堆栈；最终日志为 2 文件 18/18、exit 0，controller 独立复跑同为 18/18。该红证堆栈指向共享 `dist`，并非最终临时 outDir 的独立红跑，属于证据链限制；最终测试若桥缺失会先因 `bridgeImport` 断言失败，设计上能捕获该回归。
- 实际 `stageRelease` 调用、6fb agent 输入、Node 22.16、官方插件及 native 输入均有记录；主 dist 与 staged `server-cli.js`/`server-core.js` SHA 分别精确等于报告值 `37e25ffc…`、`01e5b28c…`。见 `output/zody-rename-r22/server-cli-bridge/stage-runner.mts:56`、`stage-result.json`。
- 当前 stage 实测 symlink 为 0；`/tmp/node_modules`、`/private/tmp/node_modules`、`/node_modules` 不存在。只读复核 7 个静态外部模块以及 `node-pty`、`undici` 均解析到 stage/runtime/node_modules，无仓库 fallback。
- `runtime-smoke.json` 支持限定陈述：launcher `--help`/`--version` exit 0，Supervisor 真实 fork core 并 ready，`127.0.0.1` 的 `/api/server-info` HTTP 200，`stop` exit 0，Supervisor/Core/control socket/lock 均清理成功。

**非阻断边界**
- `red-scoped.log` 是较早测试版本/共享 `dist` 的红证，不是最终临时 outDir fixture 的独立红跑；未在本轮重跑测试或构建。
- `external-resolution.json` 的 7 项是静态外部入口；`node-pty`/`undici` 属于动态 import，虽然我已确认 stage 内可解析，但实际 native/terminal 功能分支未被本次 smoke 执行。报告已将“未来动态/反射路径未完全证明”列为限制。
- 本批仅有 darwin-arm64 / Node 22.16 实证；server-info 仍为 `0.0.0-dev`、protocol 1，R30/R40、签名、发布和其他平台保持 pending。单元测试借用仓库依赖初始化，不构成发行闭包证明，真实 stage smoke 是独立证据。

**阻断项**
无。`CHANGES_REQUIRED`：无。
