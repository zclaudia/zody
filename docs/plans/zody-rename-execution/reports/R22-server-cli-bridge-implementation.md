# 独立 server-cli ESM 兼容桥候选

基线 HEAD `6fb79b35dd715d7d42ecbca46681541e293d652d`；实施者未提交。用户选择方案 A：`packages/zody-server-cli/tsup.config.ts` 两个入口共用的 ESM banner 显式使用 `createRequire(import.meta.url)`，让 esbuild 内联 CJS 的 Node builtin require 以实际入口为基点解析。原 banner 内的两个私有 `__zcode*` 绑定及引用同步为 `__zody*`。未改外置依赖、stage 算法、package/lock、define、环境变量或握手。先在 `specs/zody-rename-runtime-contract.md` 增加双入口规则与验收；新增 `packages/zody-server-cli/test/packagedRuntimeSmoke.test.ts`。三文件相对 6fb 的 before/after SHA 在 `change-hashes.json`。

先在短隔离 HOME/TMP 下使用真实 tsup 运行 scoped 回归：`pnpm --dir packages/zody-server-cli exec vitest run test/packagedRuntimeSmoke.test.ts`，1 文件中 1 失败、2 通过，exit 1；失败明确是 `Dynamic require of "fs" is not supported`（`red-scoped.log`）。加桥后实际通过。首个尝试曾用 `pnpm --filter @zody/server-cli test -- test/...`，被 Vitest 当作全包选择，实际 28 文件中 27 通过、1 按预期失败；原始 `red.log` 保留，不把它当 scoped 结果。

最终测试使用异步文件和进程 IO，实际运行生产 tsup config，以 `process.execPath <已安装 tsup package.json 声明的 bin> --out-dir <测试独立临时目录>` 调用，不写共享 dist；构建和入口执行均只传临时 HOME/TMP/XDG、必要 PATH/Windows 系统变量和 `ZCODE_ENV=production`，不继承用户 provider/凭据覆盖；临时 `node_modules` 链接仅供该单元初始化用例读取已安装依赖，不作为发行闭包证据。检测两个 bundle 的 `__require` 实际调用、`require` 桥与逃逸，拒绝非 builtin 字面目标、计算目标和别名逃逸，并验证 CLI 抵达未 staging 的命令委派分支。与现有 `test/packaging.test.ts` 一起运行，2 文件 18/18 通过、exit 0（`final-env-tests.log`；新增第五项验证构建环境不继承 provider 和 secret 覆盖）；`typescript` 已是该包 devDependency。真实主 dist 单独按 `pnpm --filter @zody/server-cli build` 构建，exit 0。

对最终两份主 dist 和 stage 内对应文件做 TypeScript JS AST 审计（`require-audit.json`、`import-audit.json`）：两个 bundle 各 7 个 `__require` 调用，只指向 `fs`、`stream`、`zlib`、`util`、`events`，没有该帮助器的计算目标或逃逸；`require` 仅出现在显式桥与帮助器内部。被识别的静态 import/export 与 `import()`/`require()` 调用中，绝对字面导入和计算目标均为 0。AST 审计范围和识别方式写在 JSON 中，不宣称对任意反射或未来构建作了全语义证明。stage 的两个入口与主 dist 字节相同：server-cli SHA `37e25ffcfd9469f4215663bba39fdafd090c9bf6a2a83c18b0764c78b2671264`，server-core SHA `01e5b28cb65816ed847ef159282da9c63983953af792bc1247c2ae54229d1503`。

真实 staging 使用现行 `stageRelease` API 和与 `stageCli.ts` 对应的目标、workspace 名称映射、官方插件目录、Node notice、第三方 notice 与离线 native tools；唯一有意差异是把输出定向至本任务短 `/tmp`，并关闭最终 archive，避免 stageCli 固定写包内 `dist-release`。没有使用模拟 agent。R10 提供的同 6fb 构建 agent `zody.cjs` SHA `eda9da94904c506b6fb6752685e627668eca0c40ea01682908c5ac23283f38ac`；6fb 回执与构建日志保存在 `inputs-6fb/manifest.json` 和 `stage-inputs.json`。官方插件输入按回执核验 27 个 package/plugin/runtime hash 全部相等；输入来自只读的 clean 6fb 验证树，结束时该树 status 仍空。native search 由当前脚本从仓库归档离线准备并校验，日志 `native-tools.log`。

随包 Node 为现行 `SERVER_RUNTIME_NODE_VERSION=22.16.0`。使用 R02 从 Node 官方 v22.16.0 归档取得的 darwin-arm64 缓存二进制；本次实际 `--version` 为 v22.16.0，SHA `a45751fbfe88440bebff63cd44814e4ed6deb642bc3e3c4a14c4f8ae0ed9e019` 与 `legacy-runtime-artifacts.json` 中已记录的发行 Node 一致，来源见 `legacy-runtime-server-cli-build.log`。stage `stage-final.log` exit 0；不包含正式签名或发布。

实际发行目录位于独立短 `/tmp`，不是仓库或其子目录；runtime 中 symlink 数为 0（`runtime-symlinks.txt`），`NODE_PATH` 未设置，测试进程 cwd/HOME/TMP/XDG 均为独立临时目录；`/tmp/node_modules`、`/private/tmp/node_modules`、`/node_modules` 均不存在。以 stage 内随包 Node 22 的 `import.meta.resolve` 核对两个 bundle 的七个非 builtin 静态模块（`node-forge`、`yaml`、`yauzl`、`zod`、`@hono/node-server`、`@hono/node-ws`、`hono`），realpath 全部在 stage 自身 `runtime/node_modules`（`external-resolution.json`，exit 0）。这证明被核对的入口与实际路径没有回落仓库，不扩展为所有未来动态路径闭合。

在相同隔离发行根实际执行 launcher `--help`、`--version` 均 exit 0；前台 Supervisor 真实 fork server-core，ready 返回 `127.0.0.1` 动态端口，GET `/api/server-info` 为 HTTP 200；经 launcher `stop` exit 0，Supervisor 和 Core 均退出，control socket 与 lock 均不存在（`runtime-smoke.json`，exit 0）。未注册系统服务、调用模型、访问真实用户目录或发送凭据。实际 server-info 中 version 为 `0.0.0-dev`、protocolVersion 为 1；当前 define/协议尚待 R30/R40 后续任务，不能把此 smoke 描述为新代际合同或发行通过。仅本机 darwin-arm64 实跑，其他平台保持 pending。

最终根 `pnpm typecheck`、`pnpm lint` 均再次 exit 0（`typecheck-env-final.log`、`lint-env-final.log`）；此前配置候选 `pnpm architecture:check --changed` exit 0，lint 303 warnings；独立包 `tsc --noEmit` 和三个修改文件 `oxfmt --check` 均 exit 0。baseline architecture/context 均 exit 0，但 policy 标记 server-cli `managed: false`，不能将其视为完整模块边界证明。`git diff --check` 对 tracked 修改通过；未修改主控报告/ledger、锁文件、第三方 pair 或 R10 验证树。完成后停止源码及共享 dist 写入，待主控固定候选和独立审查。

最终返修仅修改新测试的构建进程环境与入口，未改变 tsup 配置或 stage 输入；此前真实 staging 与双入口 smoke 的对应产物 SHA 仍为上述值，没有重复构建或声称新一次 staging。`format-test-env.log` 为最终测试文件的格式检查。

## Controller review

Controller independently verified all three source/spec/test before/after hashes against fixed6fb and current files, checked that none is a license inventory input, and confirmed staged server-cli/core bytes equal the actually built main dist. Controller reran the final isolated-output/environment production-bundle regression plus packaging tests:2files18/18 exit0, diffcheck0. Evidence output/zody-rename-r22/server-cli-bridge-controller/{verification.json,tests.log}. This does not relabel the earlier unit borrow of installed dependencies as hermetic; the separate real Node22 staged smoke and path audit supply that bounded runtime evidence. Independent review follows on the fixed candidate.
