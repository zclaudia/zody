# R02 旧运行时隔离构建

2026-11-02，macOS arm64。隔离源码 `output/zody-rename-r02/legacy-runtime-source` 是 detached worktree，commit `033f91783901e6adaf968d3d4b8ca34c41d89442`；构建前可用空间 62 GiB，结束约 57 GiB。Node `v24.14.0` 来自本任务 toolchain，pnpm `10.33.2` 与基线 `packageManager` 一致。`pnpm install --frozen-lockfile --store-dir ../legacy-runtime-store` 退出 0；工作树自己的 `node_modules`、store、npm/Electron 缓存均独立于实施工作树依赖。node-gyp 使用宿主既有 Node headers cache。执行命令及完整日志位于 `output/zody-rename-r02/legacy-runtime-*.log`；源码 worktree `git status --porcelain` 为空。

| 顺序 | 命令（cwd 为隔离源码根）                               | 结果                                                                                                                                                                                              |
| ---- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `node scripts/build-desktop-agent-cli.mjs`             | 退出 0；构建旧 Agent、依赖和插件运行时并暂存 Desktop agent。                                                                                                                                      |
| 2    | `pnpm --filter @zcode/server build`                    | 退出 0；生成 HTTP 和 remote bundle。                                                                                                                                                              |
| 3    | `pnpm --filter @zcode/web build`                       | 退出 0；有大 chunk 和动态导入告警。                                                                                                                                                               |
| 4    | `pnpm --filter @zcode/server-cli stage`                | 退出 0；生成 darwin-arm64 独立发行目录和归档，staging 下载 Node v22.16.0，native search 使用仓内归档。                                                                                            |
| 5    | `pnpm --filter @zcode/desktop build:no-runtime-assets` | 第一次退出 1：隔离树缺失 CUA manifest。使用已备份 v4 归档在该隔离树中执行 `restore-cua-narrow-frozen.mjs` 退出 0，再次运行构建退出 0，生成 Desktop/Host/renderer 编译输出；未执行签名或应用打包。 |

`legacy-runtime-artifacts.json` 对各产物目录逐文件记录 SHA256、文件大小或符号链接目标及目录清单摘要，文件本身 SHA256 `6e3e72f91cfc4615e766802b9cebda59db5244e4fc1c9ce16118863439580f7e`。关键文件：

- Agent `apps/zcode-cli/packages/cli/dist/zcode.cjs`: `e127ae619d1a9b97b60b76d7cd4231d292f2777d631a6660d757ae3a43e32b30`。
- Server `packages/server/dist/entry-http.js`: `21b0293d92679de7dc595b582a83c65b160b8021b9249e51b913877550688229`；remote `zcode-server.cjs`: `06b7511cd791a356558fe52781c181b50fd4103ca7552e49b95d34e277586e8d`。
- 独立 server-cli 归档 `packages/zcode-server-cli/dist-release/zcode-server-darwin-arm64.tar.gz`: `36935416dda349b94ec4a116616ab02d4ccfb955200157b1230676691ba8d580`。
- Web `packages/web/dist`、Desktop `packages/desktop/out`、server-cli 发行目录及 Desktop bundled agent 的逐文件摘要见上述清单；均保留在隔离工作树。

构建来自同一旧 Git checkout 和锁文件，但 Desktop 仅完成 `build:no-runtime-assets`，没有完整 runtime assets、安装包或应用启动证据；不能把它当作已验收的 Desktop/Host 运行制品。旧代码的 services 含多处 `homedir()` 或真实 HOME 回退，单独设置 `ZCODE_DATA_BASE_DIR` 不足以证明所有初始化路径不会读取用户数据；在无法证明完全隔离时未启动 HTTP、stdio 或 UI，未读取真实凭据/会话。故两个 HTTP 入口的构建成功不等于可运行 smoke 或相互兼容；仍需在确实隔离用户目录的环境验证旧/旧 stdio、trusted host continuous、Web/手机 replayable 和两套 HTTP 发行入口，再执行 R48 新旧双向混布。R48、R60 均未通过。

## Linux arm64 容器隔离 smoke（2026-11-03）

为避免宿主用户目录回退，使用 Docker/Colima Linux arm64、官方 `node:24.14.0-bookworm` 镜像（digest `sha256:5a593d74b632d1c6f816457477b6819760e13624455d587eef0fa418c8d0777b`），通过 `git archive 033f91783901e6adaf968d3d4b8ca34c41d89442` 导入旧源码至容器内 `node` 用户目录。未挂载宿主目录或传入凭据；冻结依赖安装及构建阶段联网，`node v24.14.0`、`pnpm 10.33.2`，`pnpm install --frozen-lockfile`、`node scripts/build-desktop-agent-cli.mjs`、`pnpm --filter @zcode/server build`、`pnpm --filter @zcode/server-cli stage` 均退出 0。server-cli stage 下载其 Linux Node v22.16.0 并使用仓内 native-search 归档。构建前宿主剩余约 57 GiB，构建中约 52 GiB。

执行 smoke 前断开容器 bridge，`docker inspect` 确认 `networks={}`、`mounts=[]`；用户目录和数据根均在容器内。`legacy-runtime-linux-smoke.mjs` 是外置 harness，完整结果和 stderr 分别保存为 `legacy-runtime-linux-smoke.json`、`.stderr`：

- **packages/server HTTP**：旧 `entry-http.js` 在容器 loopback 启动，`GET /api/server-info` 返回 HTTP 200，版本 `0.1.0`、protocolVersion `1`；进程随后结束。这验证信息端点，不等于完整业务和远程链路。
- **Agent stdio**：旧 `zcode.cjs app-server --stdio` 返回 `startup/runtimeIdentity` 的 `{initialized:true,reused:false}` 和 `runtime/capabilities` 的有效结果；进程随后结束。这是 harness 对真实 Agent 的协议请求，不是实际旧 Host 与 Agent 的集成验收。
- **独立 server-cli HTTP**：Linux 发行包入口 `bin/zcode serve --server-root ... --json` 启动退出 **1**，HTTP 未启动。当前保存一份可复核的 Linux 失败日志；完整栈见 `legacy-runtime-linux-server-cli-smoke.log`，首因是打包后的 `runtime/server-cli.js` 在载入 `yazl` 时抛出 `Dynamic require of "fs" is not supported`。这是此旧版 Linux 发行包的实际阻塞，构建通过不能替代运行成功；没有修改旧产品源码或绕过错误。

Linux 制品独立保存于 `legacy-runtime-linux-artifacts/`，容器内外 SHA256 一致：Agent `e127ae619d1a9b97b60b76d7cd4231d292f2777d631a6660d757ae3a43e32b30`，Server HTTP 入口 `21b0293d92679de7dc595b582a83c65b160b8021b9249e51b913877550688229`，server-cli Linux arm64 归档 `481126676de7de1feee727b28ef05aaced1a0afee208370e276a6c0fb9a65aaa`。HTTP dist 外部依赖未作为独立发行闭包保存；其运行验证使用容器内锁定安装。不得将 Linux 结果当成 macOS Desktop/Host 运行证明。容器清理前的进程清单只剩测试容器 init/sleep 与检查命令；清理记录在 `legacy-runtime-linux-cleanup.log`。现阶段 R48 仍受独立 server-cli 启动失败及真实旧 Host/Agent、continuous、replayable 和新旧混布未验证所阻塞；R60 未验证。

主控于 2026-11-03 补充容器清理复核：`docker ps -a --filter name=zody-r02-legacy-smoke-20261102 --format '{{.ID}} {{.Names}} {{.Status}}'` 退出 0、输出为空，命名测试容器已不在容器列表。证据为 `output/zody-rename-r02/controller-container-cleanup-check.log` 和同名 JSON。该命令仅检查本任务容器，没有清理其他容器。macOS 的独立发行失败复现另见 `R02-server-cli-baseline-defect.md`，不以重复次数替代实际日志。
