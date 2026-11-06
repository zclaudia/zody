# R45 independent bounded acceptance

Read-only reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a3fa-9ff5-7530-93dc-c253ccfcbfd1`, DeepSeek. Formal WDIO promotion, CUA, mobile and release are excluded.

**R45 阶段结论**
**Bounded accept**。R45 artifact 媒体范围未发现新的具体阻断，可进入阶段验收归档；不等于正式 WDIO/E2E、默认 arm64 CUA、手机链路或整体 release 通过。

**已核验**
- 50 个 source hash 全部匹配；仅 4 个 pending test/doc 文件变化，产品源码与构建字节未变。最终 artifact manifest 为 6710 条、159,731,400 bytes；与 run06 实际 manifest 对比只有 `packages/desktop/out/e2e/tsconfig.e2e.tsbuildinfo` 变化，全部运行时代码/Agent 资源 hash 相同。
- run06 `result.json` 为 `status: passed`：两次真实 Electron 启动、Host/Agent 进程、主 prompt replay HTTP 200（请求 `87a87e40-...`），热/冷 Blob SHA 均等于输入 `f19fe636...`，两个新 part 使用不同的 `zody-artifact://` URI。
- 同一真实 Host MessagePort 的 RPC 正例返回输入 PNG；跨 session 和旧 URI 都返回真实 `fault.attachment.previewRefNotAuthorized`。旧 URI 正是 seed 的 `zcode-artifact://sess_e2e_r45_legacy/legacy`，不是任意伪造字符串。
- `legacyBaseline` 在首次 launch 前捕获；首次和第二次检查中旧 part hash `5ff1b715...`、源文件 hash `a4da1199...` 均保持，正文可见，`legacy-ui.png` 显示旧文本和不可用媒体。
- pending test 已改为按结构化 file part、session、`url` 与 `metadata.artifactUri` 唯一定位，冷预览按正文 row 和唯一媒体卡定位；不再用即时无 blob 作为拒绝证据。正式 pending 仍未运行、未 promote，这一限制保留。
- `typecheck-02`、`lint-02` 均 exit 0，lint 303 warnings；此前 root/CLI/critical 结果仍与记录一致。未独立重跑测试、构建或安装。

**非阻断证据注意项**
- run06 另有一条会话标题生成 `POST /anthropic/v1/messages` 返回 `500 Missing Fixture`；主发送请求为 200，媒体读取正例和拒绝探针均通过。不能概括为“所有 HTTP 请求均 200”，但该项不影响 artifact 路径验收。
- `output/zody-rename-r45/results.json` 顶层仍写 `desktop: pending; never executed`，`desktop-runner/README.md` 也保留 pre-run 表述；这是 formal pending 与 run06 独立 runner 的索引歧义。阶段接受依据应是 controller/run06 证据，不应把该字段当作 Desktop 失败或 run06 已 promote。
- 默认 arm64 CUA 未覆盖；run06 只证明 ordinary Host + arm64 Electron，W4 保留件和后续 CUA 验证仍需按原边界处理。

**Cleanup**
清理预审可继续，但只允许在最终验收后重新核对路径/inode、内容哈希和进程引用，再删除唯一候选 `/tmp/zr45-isolated-run/tmp/node-compile-cache`。不得删除 run06、run01–05、W4 保全、final manifest/hash、`run-env` 或两个完整隔离根；当前预审中的 preserved 目标尚不能替代原证据校验。
