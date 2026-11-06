# R22 四目标构建第二次尝试：f0b8db60

固定候选 `f0b8db60d904638299078a9ce2b4a25f23fc1a6c`，tree `fddf87382b3d07df2b90ff5b0a8e3abede8220e3`。从干净 edb 正常 detached checkout；锁与依赖配置未变，继续复用 9d 首次 frozen install 及已由当前源码构建的 dist，不称 f0b8 全新安装。promotion、argv、环境、时间、每阶段空间和完整日志在 `output/zody-rename-r22/f0b8-distribution-build/`。

显式 `/tmp/zr22build-...` 隔离 HOME/TMP/XDG，Node 24.14.0、pnpm 10.33.2、Homebrew Python、`ZCODE_ENV=production`。固定候选 `pnpm typecheck`、SEA loader 定向回归以及 `ZCODE_TARGET_OS=linux` Desktop 配置 8 项各退出 0。之后真实 `pnpm build:zody --all --out-dir <新任务目录>/artifacts` 未使用 skip-build，退出 1；CLI、server、web 和 browser-use 构建完成，首个 darwin-arm64 SEA 收集器缺 `apps/zody-cli/packages/android-emulator-plugin/dist/mcp/server.js` 并失败。未完成目标归档，未运行归档 smoke；不能据此判定其他目标成功。结束可用 35,040,620,544 字节，未触发空间停止。

未安装、修改源码/锁、进行正式签名或上传。此前 edb 失败和长临时路径事实保留在 `R22-distribution-attempt-edb.md`。本次中间产物与日志保留供前置闭包审计；strict 19 与完整 R22/发行门禁仍未完成。
