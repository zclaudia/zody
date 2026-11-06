# R45 scope review

Read-only reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a3fa-9ff5-7530-93dc-c253ccfcbfd1`, DeepSeek; implementation baseline `04860520`.

**Scope 核验**

- 冻结候选已重绑 `04860520b23e184913efd3640d72236a079b89db`：184 个 occurrence、`unresolved: 0`、46 existing + 3 planned + 1 conditional。
- 46 个 existing blob 与 conditional blob 均同时匹配 `8d953d3c` 和 `04860520`；3 个 planned 文件在基线上不存在，scope 未变。
- R43 封存提交改动 16 个文件，全部在 `packages/server`、R43 spec/report、ledger/assignments，与 R45 写集零交集。
- 所有活动 occurrence 的路径均在写集内；21 个含旧 scheme 的生产 `src` 文件均有对应 row。没有发现漏掉的 active producer/consumer 路径。
- `prompt-input.test.ts` 的历史输入、`zodySessionProjection.test.ts:976` 的历史 PDF、`runtime-persistence.test.ts:2475` 的 `/tmp/zcode-artifacts/` 无关路径均保留；没有 `zcode-artifact://share/:id` 生产代码，未恢复已删分享能力。
- `ARTIFACT_IMAGE_RENDER_PREFIX` 仍是私有相对渲染标记，不应改；`markdown-image.tsx` 仅条件预留。

**结论**

未发现足以否决写集的阻断性 scope 遗漏。R43 依赖现已满足，可以给 **条件性 R45 实施许可**：控制器锁定 46+3+1 精确写集后，先补红测再实施 R45.1/R45.2。这不是代码通过，也不代表 Desktop E2E 已执行。

**必须守住的高风险边界**

- `apps/zody-cli/packages/bootstrap/src/app/create-app.ts:1119-1126`：`metadata.artifactUri` 不能仅替换前缀；旧 scheme 必须在进入 `readBinaryFile`、`stat`、`ensureMediaAttachmentPath` 前被拒绝，且不能把旧 `metadata.artifactUri`/`url` 转成文件路径。`session-persistence.test.ts` 需有旧 URI 即使底层字节/缓存存在也不可读、不调用文件读取的红测。
- `apps/zody-cli/packages/core/src/runtime/helpers/attachment-path-reference.ts:76` + `attachments.ts`：旧 image/video/PDF 都必须 fail-closed 为 placeholder/元数据，不能走 inline 文本或路径分支。尤其只翻转 `isDataOrArtifactUrl` 会让旧 video 落入 `resolvedInlineTextAttachment`，必须显式处理并在 `prompt-attachments.test.ts` 覆盖。
- `apps/zody-cli/packages/bootstrap/src/zody-protocol-v4/v4-gateway.ts:588-590` 只覆盖 assistant markdown；user `previewRef` 的 read/stat/previewSource 分支还需按“新 scheme + 当前 session”校验，且要在 cache/Host 读取之前拒绝旧 URI 和 foreign session。`v4-native-attachments.test.ts` 应覆盖旧 `previewRef`、foreign `previewRef`、stat、previewSource，断言 Host/read 未调用。
- `isUriAttachmentRef` 保持 generic URI 形状识别，不能作为读取授权；旧 URI 可作为 opaque 字符串保留，但不能读取或物化。
- `packages/desktop/src/host/remoteMediaPreviewProxy.ts` 是 path-only 且不在生产写集；UI 红测应证明旧 ref 不会到达 `mediaPreviewService.prepare`/`openPath`。不需要为此改生产文件。
- `markdown-image.tsx` 只有在旧 markdown 红测证明会触发 `readAttachment` 或路径读取时才改；否则保持不动，避免无谓改动。
- E2E 计划本身足够作为 scope 门禁：隔离 HOME、合成旧 SQLite 会话、旧 URI/字节/文本/缓存/源路径、冷重开、源 hash 不变、无新写入、新上传/重启、跨 session 拒绝、无第二 Host/Agent。但它仍是 `manual-review/pending`，不能宣称已通过。

**次要测试缺口**

`apps/zody-cli/packages/bootstrap/src/app/prompt-input.ts:86` 的 `materializeInputHistoryEntry` 在锁定测试集中没有直接红测。建议在 `session-persistence.test.ts` 补一个 old/new input-history case，或明确接受“旧 artifact-backed input-history 内容降级为 metadata-only”的语义。

**未声明**

未运行 build/install/test，未启动服务，未执行真实 Desktop E2E；本结论仅限 R45 scope 与实施准入。
