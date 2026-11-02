# Retry EOF capture 失败调查（只读）

## 已确证事实

- `retry-native-stderr.json`：
  - gen1 `presented`，`allowed=false`，reason `authority-eof`。
  - gen2 `presented`，`allowed=true`，reason `user-approved`。
  - gen1/gen2 之后分别记录 `capture-rejected`，gen2 的 reason 为 `capture-failed`。
- 因此本次用户确实批准了新的 gen2 prompt；confirmation generation/context 残留可以排除。
- 失败发生在批准后的 capture 阶段。`cua_native_capture_closed:eof` 与 owner `control-lost` 是 native 关闭 authority 连接后的下游结果，不是根因。
- Helper/Node 在失败后仍存活，无崩溃，也没有截图或 `captureResult` 交付。

## TCC 证据边界

- OS 日志显示 `18:13:15.714` 对 `kTCCServiceScreenCapture` 的 preflight 为 yes，结果 `authValue=2`、`authReason=4`、`error=null`。
- 该记录的责任主体是 Codex (`com.openai.codex`, PID 8157)，requesting 为 helper PID 15368；不能据此宣称 Helper 自有 TCC 归属已验收。
- 即使按该记录，TCC 也没有返回拒绝，因此不能把本次失败直接归因为 TCC 未授权。

## 可诊断性根因

`session_supervisor.mm` 的固定 reason 映射把以下不同的 Helper 失败折叠成同一个 `capture-failed`：

- `visual-*`（start / wait / takePNG / PNG 校验 / 资源归还 / destroy）
- `tcc-*`
- `capture-context*`
- `machine-lease-not-held`
- `authority-revoke*`
- `write-*`

当前证据无法区分具体失败阶段，不能据此猜 TCC、visual 或写盘失败。

## 最小修复

- 只修改 `packages/desktop/native/macos-cua-desktop-session/src/session_supervisor.mm` 的固定诊断映射。
- 逐个保留 Helper 已有的固定 reason（如 `tcc-not-authorized`、`capture-context-incomplete`、`visual-start-denied`、`visual-wait-failed`、`visual-take-png-failed`、`visual-png-invalid`、`machine-lease-not-held`、`capture-facts-missing`）。
- 动态 `cannot create/write/fsync PNG` 文本分别归入固定 `capture-create-failed` / `capture-write-failed` / `capture-fsync-failed`，不回显底层 error 文本。
- 未识别的 reason 仍落到有界泛化值；所有授权、owner、lease、资源归还和 captureResult 检查保持原样，没有放宽。
- 未修改冻结 R11 源码，未新增测试矩阵。

## 待重建后确认

需要 controller 用当前源码重建/签名后再跑一次真实授权捕获，才能从新的固定 reason 确定实际失败阶段。本报告不预设 TCC、visual 或写盘结论。
