# R22 CLI 构建前置：edb0a691

固定源码 commit `edb0a691f35ef8d5ccb8f1c6fd40d563ed5d13ff`、tree `65e54f8ce956998ce9a1a2d41975cb4302bac387`，实际 cwd 为 `output/zody-rename-r21/license-clean-9d135318`。此前 9d 的真实 frozen install 保留；将经核对与 edb 相同的两个生成 pair 文件暂存后正常 detached checkout edb，promotion 前仅该两项已跟踪修改，promotion 后工作树干净；随后构建和测试前后 Git 状态也均干净。此为复用 9d 安装，不称 edb 全新安装。promotion 字节和状态证据为 `output/zody-rename-r22/edb0-prerequisites/promotion-before.json`。

在隔离 HOME/TMP/XDG、Node 24.14.0、pnpm 10.33.2、Homebrew Python、`ZCODE_ENV=production` 下，执行 `pnpm --filter @zody/cli... build` 退出 0。实际由当前源码生成 `apps/zody-cli/packages/adapters/dist/storage/index.js`（SHA-256 `012d98f6be776ef17659cd35a72ce4d5ae07b142294479754494c18e0d88abc4`）和 `apps/zody-cli/packages/contracts/dist/index.d.ts`（`b2c8f37386c714d8b9d954977c226f8fdc2c05cd7e4ca8479ea1c6d398c4c900`），没有复制旧 dist。

随后根 cwd 运行 `pnpm exec vitest run packages/desktop/test/storagePreparationProtocol.test.ts packages/desktop/test/macosCuaHelperRound11Authority.test.ts`，退出 0，2 文件、7/7 测试通过。命令、时间、工具链、空间与原日志在 `output/zody-rename-r22/edb0-prerequisites/`，最低记录可用空间 37,958,610,944 字节。该结果解决此前两个定向测试缺失当前 CLI dist 的前置验证，不抵消原始全量失败，也不代表整个 R22 通过。
