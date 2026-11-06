# R45 independent code review

Read-only reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a3fa-9ff5-7530-93dc-c253ccfcbfd1`, DeepSeek. Candidate code only; Desktop and phase acceptance pending.

**结论**
R45 代码范围可给 **bounded candidate PASS**。未发现新的具体阻断；现有实现满足旧 URI 硬拒绝、同 session 授权、历史原值保留和私有无前缀不变。该结论不包含 Desktop/E2E 或阶段性整体验收。

**核验结果**
- HEAD 为 `04860520b23e184913efd3640d72236a079b89db`；50 条 source hash 全部匹配，48 changed、2 unchanged。实际为 45 个已跟踪修改加 3 个计划新增文件，写入范围与 R45 assignment 一致。
- Store 仅解析和生成 `zody-artifact:`：`apps/zody-cli/packages/adapters/src/storage/index.ts:82`、`:116`、`:486`。
- 旧媒体在文件、内联、缓存回退前被拒绝：`apps/zody-cli/packages/bootstrap/src/app/create-app.ts:1122`、`:1128`、`:1138`；core 同时检查 `content` 和 `path`：`apps/zody-cli/packages/core/src/runtime/helpers/attachments.ts:150`。
- Input-history 旧 URI 丢弃内容及路径，只保留类型元数据：`apps/zody-cli/packages/bootstrap/src/app/prompt-input.ts:86`。
- Gateway 的用户 read/stat、`previewRef`、attachmentRead/previewSource 均在 Host/cache 前拒绝旧 scheme 和跨 session ref：`apps/zody-cli/packages/bootstrap/src/zody-protocol-v4/v4-gateway.ts:2125`、`:2180`、`:2251`；assistant markdown 仅授权当前 session 的精确 ref：`:2299`。
- `zodyRename` 之外的 generic URI 形状识别仍保留，但 gateway 的授权依据是权威行和新 session ref，不是 URI 形状本身。
- 私有渲染前缀保持 `/__zcode_artifact_image__/`，历史 fixture 保持旧值：`packages/shared/src/markdown-artifact-images.ts:1`、`packages/shared/test/markdownArtifactImages.test.ts:44`、`packages/ui/test/zodySessionProjection.test.ts:976`。
- 固定工具链结果与主控提供的证据一致：adapters 9/9、bootstrap 233/233、core 521/521、root 223/223；legacy persisted 用例 1 通过、40 skipped。`typecheck`、`lint`（303 warnings、0 errors）、`architecture:check --changed`、CLI typecheck、bootstrap critical 均 exit 0。

**保留项**
- Desktop pending 用例尚未实际执行；真实 Electron/Agent、冷重开、跨 session、无缓存绕过仍待 Desktop owner。当前报告的“未运行/不充分”表述正确，不能宣称 E2E PASS。
- `session-mapper.ts` 的旧 URI 注释和测试专用 journal fixture 不属于生产读取路径，不构成阻断。
- 本轮未独立重跑测试、build、install 或 lint。
