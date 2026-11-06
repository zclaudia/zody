# R46 independent scoped acceptance

Read-only DeepSeek reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a3fa-9ff5-7530-93dc-c253ccfcbfd1`. Controller adopts this scoped acceptance; original failures and release limits remain.

**结论**
这份聚合证据足以支持 **scoped R46 验收**，并可进入阶段清理准备；不构成完整 E2E/release 验收。未发现新的产品代码或测试阻断。

**账实核对**
- `controller/results.json` 记录 17 个 runner、43 个可运行文件、1,240 个按文件归并用例；计算链 `473 + 40 + 60 + 288 + 174 + 168 + 37 = 1,240` 一致。
- 15 个 runner exit 0；`focused-root-01` 和 `focused-cli-01` 的 exit 1 明确保留为历史失败，修复由 `service-protocol-02` 40/40 和 `focused-cli-node-02` 174/174 覆盖，未重复计数。
- `source-hashes.json` 98 路径当前 SHA256 全部匹配；`sourceManifestSha256`、`runnerSha256` 以及 17 组 runner/log 的登记哈希均匹配。
- 边界记录完整：3 个 formal E2E 未运行；R22 full-suite、strict 19、CUA、跨平台/signing/release 保留；R45 Desktop/Agent 仍是最近有效制品，R46 未重建。

**需同步的一处文档**
`docs/plans/zody-rename-execution/reports/R46.md:14` 和 `:24` 仍写“独立 review 2/终审待完成”，与 `results.json` 的 `review2 passed; stage cleanup pending` 不一致。这是文档状态问题，不影响上述代码/测试证据；最终签收前应改为“review2 已通过，阶段清理待完成”。

**清理边界**
可以进入清理准备，但删除动作仍需按 cleanup manifest 的精确 root/inode/SHA/lsof 映射执行，保留原始 runner/log、历史失败记录、3 个未运行 E2E 证据和 R45 最新有效制品。无需因本轮证据重跑测试或重新构建。
