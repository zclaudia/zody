# R22.1 ad859 静态与测试验证

固定检出 `ad859813ec8ace8e21d418186cfe1d16939abb59`，tree `afd5f87a9dfb8f05446d5feaf1f5d37d1a9f36e2`；所有命令 cwd 为 `output/zody-rename-r21/final-clean-4fac2fb0`。根单元测试未通过，R22 gate 不能据此标记通过。未修改源码、测试或锁文件，结束时该检出的 `git status --short` 为空。

执行记录、完整 argv、精确 exit、时间和每条主队列命令前后的可用空间见 `output/zody-rename-r22/ad859-static/commands.json`，各命令同名 `.log`。初始空闲 12,681,695,232 字节，主队列最低命令结束余量 10,037,297,152 字节；超过 8 GiB 停止阈值。隔离变量清单记录于该 JSON：HOME、TMPDIR、XDG_CONFIG_HOME、XDG_CACHE_HOME、XDG_DATA_HOME、PATH、LANG、CI；未传凭据。实际 `pnpm exec node` 证明项目脚本 Node 24.14.0、pnpm 10.33.2（`actual-versions.log`）。隔离 XDG 下 pnpm 管理器自行下载 pnpm 10.33.2 工具缓存，并非项目依赖安装；测试中的 electron-builder 另下载 NSIS 测试工具资源，未进行发布或发行证书签名；定向 peer 诊断用例运行了临时 ad-hoc peer。

| 顺序 | 实际命令（根 cwd，绝对 pnpm/Node 见 commands.json） | 结果 |
| --- | --- | --- |
| 1 | `node scripts/check-workspace-freshness.mjs` | exit 0 |
| 2 | `pnpm typecheck` | exit 0 |
| 3 | `pnpm lint` | exit 0，303 warnings、0 errors |
| 4 | `pnpm architecture:check` | exit 1：`gen-ui-service` 缺 `contract.test.ts`；`pluginUiBridgeService.ts` 404 行超过 400 限制 |
| 5 | `pnpm knip` | exit 1；日志报告 unused files 676、unused dependencies 52、unused devDependencies 18、unlisted dependencies 169、unused exports 1448、unused exported types 1351、duplicate exports 46。此为工具原始报告，未经逐项确认 |
| 6 | `pnpm test:unit --maxWorkers=2` | exit 1；1792 文件：1755 通过、34 失败、3 跳过；15972 测试：15843 通过、104 失败、25 跳过 |
| 7 | `node --test scripts/zody-distribution-runner.test.mjs scripts/zody-distribution.test.mjs scripts/zody-distribution-smoke.test.mjs` | exit 0，18/18 通过 |
| 8 | `pnpm --dir packages/desktop test:macos-cua-narrow-resources` | exit 1，33/37 通过；四项失败因干净检出缺 `output/cua-app-icon/controller-prepared/manifest.json` 或 `output/cua-helper-round11/controller-signed/identity-pins.json`，完整日志保留 |
| 9 | `node --test packages/desktop/scripts/restore-cua-narrow-frozen.test.mjs packages/desktop/scripts/cua-desktop-session-bundle.test.mjs packages/desktop/scripts/cua-desktop-session-candidate-fetch.test.mjs` | exit 0，18/18 通过 |
| 10 | `pnpm exec tsc -b packages/desktop/tsconfig.main.json` | exit 1，85 项 TS 诊断；非 Main 通过 |

首次全量单测的隔离环境产生明确干扰：过长 TMPDIR 使 Unix socket `listen EINVAL`；PATH 选中系统 Python 3.9，缺 `tomllib`。保留原始失败并用独立短 `/tmp/zr22.*`、Homebrew Python 3.14.3 定向重跑 `pnpm exec vitest run --maxWorkers=2`，目标为 `packages/zody-server-cli/test/{ipc,supervisor}.test.ts`、`packages/desktop/test/{macosCuaPeerDiagnosticNative,macosCuaDriverLicenseSupplements,macosCuaDriverRound8Prepare,macosCuaDriverRound9Prepare}.test.ts`，6 文件 62/62、exit 0，日志 `targeted-env-rerun.log`。定向重跑未单独采集前后 df；结束时磁盘可用约 11 GiB。此结果不覆盖全量结果，也不能据此解释其他失败。全量日志还包含 UI、gateway、环境/原生资源及其他失败；仅按日志记录，不把既有 UI2、gateway1、clean CLI2 等相似名字擅自判定同因。

`main-comparison.json` 将本次 Main 输出与 `runtime-bcd/main.log` 比较：两边均为 85 项，规范化检出根路径、双引号字面 union 顺序以及 `ArrayBuffer`/`ArrayLike<number>` union 顺序后完整诊断文本一致；行号和其余诊断内容均保留。此结果不替代 Main 修复或架构 gate。

未运行 `build:zody`、WDIO、真实应用或发布；许可身份修正等待用户对齐；完整构建留待后续验收步骤。
