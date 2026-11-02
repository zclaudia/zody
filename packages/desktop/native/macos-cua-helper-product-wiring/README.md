# macOS CUA Helper 产品组合候选（原生派生）

本目录只放**派生说明、固定 patch 与平台裁剪**；不改 R11 冻结源码，不签名、不请求 TCC、不采集。
真正的 sealed ESM 入口是 `apps/zcode-cli/packages/bootstrap/tests/fixtures/cua-native-owner-entry.ts`
（测试构建源，不是生产公开 API）。

## 派生来源与固定基线

- 来源：`packages/desktop/native/macos-cua-helper-round11/src`（R11）与
  `packages/desktop/native/macos-cua-peer-diagnostic/src`（R10 peer/frame/identity）。
- 基线：`source-baseline.json`，取自 controller-signed R11 冻结
  `build-manifest.json` 的 `sources`（14 个 `.mm` + 20 个头文件，共 34 条）。
- builder **只复制实际编译源 + 头文件**，逐条比对基线；任一缺失或不匹配即拒绝（`baseline-mismatch` /
  `baseline-missing-entry`），不会“记录后继续”。
- `orchestrator.mm` 额外固定基线 SHA 与打补丁后的输出 SHA；patch 以 `--fuzz=0` 应用，
  两处任一不符即拒绝。

## 原生 patch（逐个 pin，`--fuzz=0`）

`source-baseline.json` 的 `patches` 数组按顺序记录每个 patch 的 `sha256`、目标文件、
`beforeSha256` 与 `afterSha256`；builder 逐项校验，任一不符即拒绝。

1. `patches/orchestrator-empty-bootstrap.patch`
   - 删除随机 host/app/run/turn/source 身份的 developer bootstrap，改发空 payload `{}`。
   - 严格从 sealed JS 的 bootstrap 回执读取 `traceId/ref/producerIncarnation/runId/turnId`，
     缺任一字段即 `authority-bootstrap-rejected`，不 fallback 造 ID。
   - authority snapshot 上限从 8MiB 有界提升到 32MiB（真实 create-app sealed ESM 约 26.5MiB）；
     wire frame 合同仍是 16KiB。
2. `patches/orchestrator-helper-result-reason.patch`
   - helper 非 0 退出时保留 `result.reason` 的安全窄原因（string、≤128、字符白名单），
     不再用 `helper-exit-not-success` 遮盖；无有效原因才回落 `helper-exit-<code>`/`helper-exit-timeout`。
   - 仅增加可观测性，不放宽授权、权限或检查。
3. `patches/node-stderr-observability.patch`
   - 在 `launch_authority_node` 的 file actions 中显式
     `posix_spawn_file_actions_adddup2(fd2, fd2)`，使 `POSIX_SPAWN_CLOEXEC_DEFAULT`
     不再关闭 sealed Node 的 stderr；只为最小诊断，不改 stdout/权限/授权。

> 冻结 R11 manifest 的 `.mm` 以裸文件名记录；`source-baseline.json` 为 stage 映射统一加
> `round11/src/` 与 `r10/src/` 前缀，hash 值未改。

## sealed ESM 与平台裁剪

- 入口用真实 `createZCodeApp` + `CommandInbox/sendText` + held model fixture。Host/workspace
  身份是 fixture **显式传入的 synthetic 值**；ref/app/run/turn 只来自真实
  `app.runtime.createCuaSubmissionTurnScope()`。entry 不 new authority、不 admitLive、
  不补造 ref/run/turn（也不另造 app）。
- ESM banner 提供 `createRequire` / `__filename` / `__dirname`，让已打包的 CJS 闭包与 builtin 可用。
- `koffi-unavailable-darwin.mjs` 是**平台裁剪**（throw-only），不是 koffi 可用实现：
  koffi 只在 win32 guard 后懒加载（`windows-job-object.ts:31`、`stdio-transport.ts:96`），
  darwin arm64 entry 显式拒绝其它 platform/arch。不声称与完整 CLI 等价。
- 运行时外部依赖以 esbuild `outputs.imports` 为准：全部是 Node builtin；输入级 type-only /
  optional 引用不算运行时依赖。`ripgrep` 只在 fs worker 源码字符串内懒加载，held-model
  fixture 不执行搜索。

## 构建

```bash
fnm exec --using=24.14.0 -- node packages/desktop/scripts/build-cua-helper-product-wiring.mjs
```

输出：`output/cua-helper-product-integration/native-candidate/`

- `build/build-manifest.json`：产物/来源/patch/bundle/许可/编译摘要
- `build/app-compile-command.txt`、`build/authority-esbuild-metafile.json`、
  `build/esbuild-audit.json`、`build/esbuild-inputs.json`
- `helper/Zody CUA Helper Round11.app`：未签名候选（bundle id 保持
  `io.github.zclaudia.zody.cua-helper`）

builder 不签名。签名、TCC 与真实一次采集由 controller 独立执行；本候选自身不产出截图证据。
