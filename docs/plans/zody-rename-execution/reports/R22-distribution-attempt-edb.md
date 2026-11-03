# R22 四目标构建首次尝试：edb0a691

固定候选 `edb0a691f35ef8d5ccb8f1c6fd40d563ed5d13ff`，tree `65e54f8ce956998ce9a1a2d41975cb4302bac387`；隔离树沿用 9d 的 frozen install，非 edb 新装。CLI 前置构建和两个目标测试的证据见 [R22-cli-prerequisites-edb.md](R22-cli-prerequisites-edb.md)。

从隔离候选根执行 `pnpm build:zody --all --out-dir /Users/zhvala/SourceCode/zody/.worktrees/zody-full-rename/output/zody-rename-r22/edb-distribution-build/artifacts`，未使用 `--skip-build`，退出 1。Node 24.14.0、pnpm 10.33.2、Homebrew Python 和 `ZCODE_ENV=production`，HOME/TMP/XDG 隔离；本次 Python 默认临时目录实际在 `/var/folders/.../zr22build-...`，**不是短 `/tmp`**，原始环境记录未改写。完整 argv、时间、每阶段空间和日志在 `output/zody-rename-r22/edb-distribution-build/`，结束可用 35,657,408,512 字节。未使用真实账号、正式证书、WDIO 或发布上传。

CLI、server 和 web 实际构建完成；首个 `darwin-arm64` 目标下载 Node 校验文件和归档后，SEA 资源收集因 `Missing @zody/shared dist files. Run pnpm build before pnpm sea.` 退出，零目标归档完成，未运行归档 smoke 或启动/提供商验证。真实缺失 `packages/shared/dist/index.js`；`sea-runtime-package-resolution.mjs` 对 workspace 包要求该文件，shared 的 tsconfig 指向 `dist`，根 typecheck 使用 `tsc -b` 包含 shared，而 shared package 未定义 build 脚本。该要求和配置在 033f 基线已存在，但没有对 033f 独立执行四目标构建，不以静态相同宣称旧构建必败。后续需在本候选运行根 typecheck 并验证真实 SEA 资产解析，不能以该次失败当最终回归结论。

`readVerifiedNotices` 的既有非 strict 构建行为不消除 19 条 reviewRequired，发行仍受 strict 与后续 R60/R61 限制。本次失败现场、下载和中间产物均保留，未自动重试、未更改源码或锁。
