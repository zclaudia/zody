# R22 71e21e4f 构建与宿主 smoke

候选 commit `71e21e4f7f941c6a3abf6e15ce0310d5610d1b52`，tree `0d3adcb94607233bdbd169e977749c89694886d8`；复用 9d 首次 frozen install，不称当前 commit 新安装。短 `/tmp` 隔离 HOME/TMP/XDG、Node 24.14.0、pnpm 10.33.2 和 Homebrew Python，未带凭据；测试后 tracked Git 状态干净。具体 argv/cwd/时间/退出码和 logs 在本目录 `results.json`；仅任务临时路径匹配的进程检查为 0，见 `cleanup-check.json`，不概括其他系统进程。

`sea-prereq-71e21e4f` 根 typecheck exit 0、CLI 全 23 tasks 强制构建 0 cache exit 0；`sea-consumer-71e21e4f` 原 dist 前置两个 root 测试文件 7/7；`sea-collect-71e21e4f` official、skill、provider 和四目标 TUI/tools/Playwright 共 15 collector 均 exit 0。`sea-distribution-71e21e4f` 实际四目标 `pnpm build:zody --all` exit 0、未用 skip；四归档及各 sidecar、总 SHA256SUMS 均实算通过。

| 归档目标 | SHA-256 |
| --- | --- |
| darwin-arm64 | `8c970ee389e30bb2befb35b6f4e2905a30ae99090440b27b75faa605ac04ac9f` |
| darwin-x64 | `7212725760d89aad8a60411eeaf13730d689d6dbf11733f0e004f1144d98872b` |
| win32-x64 | `54631ba7a3f95a669431f032d4be7f38d6fcdad09a482507c06a858b1751a1fa` |
| linux-x64 | `6f5de8636bf43b851b2b13f17923d0ce142f37503671b11accddcee40d711eb5` |

实际只运行本机 darwin-arm64 归档：`scripts/zody-distribution-smoke.mjs` exit 0，报告 TUI 原生加载/渲染/键盘退出及本地 Web HTML、server-info、workspace、WebSocket、关闭通过；解包后实际 `bin/zody --version` 和 `bin/zody-cli --version` 均 exit 0、输出 `0.1.0`。归档 provider 配置与当前生产输入 SHA-256 均为 `bba4a742c493667c4b463a9e57ff8027563406391d8f0d671935c5f846052999`；真实 `NodeZodyBuiltinProviderConfigSource.read()` 在临时 active 路径返回 revision `zcode-builtin:33:bde1268469c177a213b99a357aac03b212d974caf9d3baafa2a717c4cb5984bc`，未输出配置正文；两份 provider-node 测试 4/4、exit 0。无模型 prompt、线上 provider 或真实用户目录。非宿主归档仅构建及哈希，未运行。

归档内 `zody/package.json` 实际 `verificationOnly: true`、`reviewObligationCount: 19`；strict 许可仍失败，不能发布。Darwin 的 SEA 是本机 ad-hoc 签名，非正式证书签名。外部归档/launcher 为 zody；内部中间 `dist/zcode-<target>` 路径由 R45 处理。当前结果不等于 Desktop 正式签名、全平台运行、完整 R22 或发布通过。
