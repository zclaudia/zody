# R02-deepseek-runtime-review-1

Reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19cc4-82c8-7cc2-a81c-fee2d8b18b67`; read-only.

**R02 旧 runtime／补证：限定 PASS**

- 源码隔离可核：`output/zody-rename-r02/legacy-runtime-source` detached 于 `033f91783901e6adaf968d3d4b8ca34c41d89442`，`git status --porcelain` 为空，与 `R02-legacy-runtime.md:3` 一致。
- 隔离声明可核：`legacy-runtime-linux-isolation.log` 为 `networks={} mounts=[]`，harness 自身把数据根/workspace 指到容器内 `/home/node/...`，未见宿主挂载或凭据传入（`R02-legacy-runtime.md:26`）。
- 制品可核：容器内与宿主三份 SHA 完全一致（Agent `e127ae61…`、`entry-http.js` `21b0293d…`、server-cli tar `48112667…`），镜像 digest `sha256:5a593d74…0777b` 有拉取日志（`R02-legacy-runtime.md:32`）。
- harness 局限如实：只验证 `/api/server-info` 200 与 `startup/runtimeIdentity`、`runtime/capabilities`，未启动 Host、continuous、replayable 或完整业务，报告未越权声称（`legacy-runtime-linux-smoke.mjs`）。
- server-cli 失败为真实旧制品问题：归档内 `runtime/server-cli.js` 的 yazl 段确为 `__require("fs")`，与 `legacy-runtime-linux-server-cli-smoke.log` 的 `Dynamic require of "fs" is not supported` 首因一致；报告未记作通过（`R02-legacy-runtime.md:30`）。
- R02 补证/二审（不重做 1979）：`evidence-index.json` 48 项逐项实算 SHA 全部一致、无缺失；`native-unsigned` = `724a67c5…`；`restore-recheck-codesign.log` 为 `exitCode: 0`、`valid on disk`、满足 Designated Requirement；`v4-source-manifest.json` 实际为 `4d6fe9cc…c68a0`（c68e 笔误已修正），`v4-source.tar.gz` `5968df6d…`、`native-evidence.tar.gz` `ee44c7d0…` 均与报告相符。
- 措辞一致性：`R02.md:22`「完整 v4 源码未证明」与 `R02.md:32`「限定四入口+patch 门禁通过」是两个层级，已不矛盾。

**非阻断更正（2 项）**

- `R02-legacy-runtime.md:30` 称「独立重试同样退出 1」，但目录只有一份 `legacy-runtime-linux-server-cli-smoke.log`/`smoke.json`，无第二次命令日志。建议改为「一次可复核失败」或补第二条实际命令与输出；不影响 R48 阻塞结论。
- 容器清理仅 `legacy-runtime-linux-cleanup.log` 记录容器名；本次 `docker ps -a` 因沙箱权限被拒、提权亦被拒，未能独立复核已删除。属环境限制，建议主控在可访问 Docker 的环境补一次 `docker ps -a --filter name=zody-r02-legacy-smoke-20261102` 留档。

**R48：CHANGES_REQUIRED（阻塞）**

- 真实旧 Host ↔ 旧 Agent stdio 集成、trusted host continuous、Web/手机 replayable 均未执行；harness 仅协议级。
- macOS Desktop/Host 未启动，`build:no-runtime-assets` 不等于 runtime assets、bundle/afterPack 或应用运行。
- `packages/server` 仅 `/api/server-info` 200，未覆盖完整业务、权限与远程 HTTP。
- 独立 server-cli HTTP 在旧 Linux 制品上真实失败，R48 在修复或明确接受该旧缺陷前不得放行；不得用新包补丁回填旧制品结论。
- 新/旧双向混布（stdio/continuous/replayable）的业务前拒绝、零副作用、进程与连接清理全部缺失；两套 HTTP 发行入口尚未分别核销。

**R60：CHANGES_REQUIRED**

- 缺最终源码重建、sealed entries/pins、helper/native tests、controller 重签、stage/manifest/demo pins、新归档与隔离恢复、真实 Desktop bundle/afterPack、交互截图；本次仅证明历史资源可恢复与宿主可列出签名身份，不证明未来重签成功。

**R20 源码保全 gate**

- 不受本次旧 runtime 结果影响，维持此前限定 PASS；本次未运行根构建、未改动旧源码或 R02 材料。
