# 复核与复跑

从仓库根使用 mise.toml 要求的 Node24.14.0、pnpm10.33.2。本机实际通过的 Node 位于 `/Users/zhvala/.local/share/fnm/node-versions/v24.14.0/installation/bin`；没有修改全局版本。本轮不要求 Rust 重建或证书/权限变更。

## 材料与增量

`evidence-sha256.json` 记录本目录每个材料的SHA-256（不含自身）。`source-manifest.json`记录68份源码/材料内容，`documentation-sha256.json`记录最终spec/design/plan/tool-chain文档。`checks/opening-files.json`是3986文件开工摘要。

在**空临时目录**解压`baseline-source.tar.gz`，解压`source.patch.gz`并运行`git apply`，即可得到本轮68文件的内容快照。controller已这样实际应用补丁并逐项比对通过。不要将补丁再次应用于当前脏工作区。这个增量不是全项目快照；构建和测试仍需要项目及前轮依赖/代码基线。

## 原生独立构建与真实场景

以下输出目录必须选新的round10目录；不会执行截图、输入、签名写操作或TCC请求。Node校准只读取已存在的签名和公开证书。

```sh
export PATH=/Users/zhvala/.local/share/fnm/node-versions/v24.14.0/installation/bin:$PATH
node --input-type=module <<'JS'
import { resolve } from 'node:path';
import { runNativePeerDiagnosticSuite } from './packages/desktop/scripts/lib/cua-peer-diagnostic-run.mjs';
const report = await runNativePeerDiagnosticSuite({
  outputRoot: resolve('output/cua-helper-round10/replay-new'),
  writeReports: true,
});
console.log({ status: report.status, evidence: report.evidence });
if (report.status !== 'pass' || report.calibration?.status !== 'pass') process.exitCode = 1;
JS
pnpm exec vitest run packages/desktop/test/macosCuaPeerDiagnosticPolicy.test.ts packages/desktop/test/macosCuaPeerDiagnosticRunner.test.ts packages/desktop/test/macosCuaPeerDiagnosticNative.test.ts --maxWorkers=2 --reporter=dot
```

Native Vitest默认写入`output/cua-helper-round10/native-work`，只能在本轮worker已结束后运行，不能与该目录的写入者并发。它在目标darwin arm64环境要求实际pass，不将blocked当作实测通过。

## 控制与回归

先在CLI workspace新构建adapters公开产物，再跑统一入口；不安装源码alias。

```sh
pnpm --dir apps/zcode-cli --filter @zcode/adapters build
cd apps/zcode-cli
pnpm exec vitest run packages/adapters/tests/cua-submission-control packages/adapters/tests/control-only-launcher packages/core/tests/cua-submission-control-binding.test.ts packages/core/tests/cua-submission-lineage.test.ts packages/core/tests/cua-submission-runtime.test.ts packages/core/tests/cua-control-channel-integration.test.ts packages/node-repl-host/test/control-only-entry.test.ts packages/node-repl-host/test/computer-use-onboarding.test.ts packages/node-repl-host/test/cua-bridge.test.ts packages/node-repl-host/test/cua-broker.test.ts packages/core/tests/node-repl-browser-injection.test.ts --maxWorkers=2 --reporter=dot
```

回到仓库根：

```sh
pnpm exec vitest run packages/zcode-cua/test --maxWorkers=2 --reporter=dot
pnpm exec vitest run packages/desktop/test/macosCuaHelperLocalSelfSignedDoctor.test.ts packages/desktop/test/macosCuaHelperDiagnostic.test.ts --maxWorkers=2 --reporter=dot
node scripts/check-workspace-freshness.mjs
pnpm typecheck
pnpm lint
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm architecture:check --changed
```

固定SDK缺失或真实socket/Security探测受限时应保留失败/blocked记录，不更换SDK、改用stub或降低签名策略。实机结果不能推广到Intel、最低macOS或未来真正Helper。
