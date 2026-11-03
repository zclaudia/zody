# 6c 独立 server-cli 构建与初始化验证

HEAD `6c987a26bbd0384ec0f1702282f880dc05e26ce2`，tree `5d6d07d49edc15bcb1ebf0737f2a9ad15e26593e`；主实施工作树根 cwd，Node `v24.14.0`，既有 pnpm 二进制 `10.33.2`。使用新建短 `/tmp/zr22srv-*` 隔离 HOME/TMP/XDG，PATH 为固定 Node、Homebrew 和系统目录，不传凭据；未执行 install。精确白名单、argv、退出码、磁盘、前后状态和逐文件 SHA 保存在 `before.json`、`results.json`。1079 个 server-cli、shared、services、rpc、provider、构建输入和锁文件的 tracked 输入前后 hash 相同。

工作树不是完全干净：runner 开始和结束时都有 `apps/zody-cli/packages/core/tests/cua-submission-control-binding.test.ts` 的一行当前包名注释修改，以及主控维护的两份报告变更；该测试文件不在 server-cli 构建输入范围，此次未改动上述内容。证据应称为固定 6c HEAD、server-cli 输入不变的工作树验证，而不是干净提交检出证明。

- `pnpm --filter @zody/server-cli build`：exit 0，tsup 生成 `dist/server-cli.js` 和 `dist/server-core.js`。前者 SHA-256 `193b2638e07279f375b3023dc36067954174825dda4bc6757b7fb6dd48855cea`；后者 `24b36c18d16063c5a9046f08927e132169837ea56b0abf4f83bc9151c4a6ca65`。完整日志 `build.log`。
- `node packages/zody-server-cli/dist/server-cli.js --version`：exit 1，尚未进入命令分发即报 `Dynamic require of "fs" is not supported`。`version.log` 显示堆栈依次经过 bundle 的 `yazl/index.js`、`services/src/feedback/feedbackLogArchive.ts`、`services/src/node.ts`。这与 `R02-server-cli-baseline-defect.md` 记录的旧版本失败机制和调用链一致；本次实际确认当前候选也有该初始化失败。不是缺少 `zody.cjs` 委派导致的错误，也不是代际握手拒绝。

按任务停止条件，未执行 stage、serve、server-info、server-core 启动、help、发行 smoke 或发布；不能据此断言 server-core 的运行结果。需要由持源码写锁的后续 owner 在 spec 和真实双入口、完整依赖/许可 closure 下修复并复验；现有独立 server-cli 不满足运行验收。
