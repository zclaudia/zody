# Independent scoped review

**结论**

`R20_BINDINGS` 冻结证据通过 **scoped stage acceptance**。未发现具体阻断项；该结论仅针对 94 个 internal binding 闭包，不代表全仓 rename、R48、正式 E2E 或发行验收。

**证据核对**

- 基线为 `aa3db87d8b9fa64be5f4fd027dac2681cdb414aa`。
- `source-hashes.json` 共 241 项：237 个已改路径、2 个 planned spec/report、2 个未提升 conditional generated 路径。
- 241 项的当前 SHA-256、Git blob，以及 237 个既有路径的基线 blob，全部匹配；无缺失或重复路径。
- `execution-record.json` 记录 48 条命令、51 个原始日志；51 个日志大小和 SHA-256 全部匹配，48 条命令均有 argv、env、childEnv 和 exit。
- 保留的真实失败一致：2 次 CLI `172/174` 旧 dist 失败，1 次 unsupported Node flag `exit 9`；最终 fresh CLI 为 `174/174`。
- focused 边界为 `662 + 28 + 229 + 89 + 2 + 174 + 47 = 1,231`，与报告一致。
- 19 个 CLI package/tool direct typecheck 均为 `exit 0`。
- root `typecheck`、`architecture:check --changed` 均为 `exit 0`；`lint` 为 `exit 0`、303 个既有 warnings。
- `source-audit` 为 236 文件、1048 个 identifier rename、3 个授权 source assertion、0 unexpected。
- node-repl-host 实际 emit：48/48 与 working tree 和基线相同，0 diagnostics，未提升任何生成物。
- 2,855 个 generated JS/declaration 扫描中，旧 binding 仅在保留的旧 CLI bundle 和旧 node-repl-host bundle；两份文件 SHA 前后不变，属于旧构建标签，不是本阶段发行证据。
- `fresh-node-repl-host/server.mjs` SHA-256 为 `858f8dc4e3cde2e871aa1468fb657730c49fc686f766be120923af90db4bd65a`；实际通过 `InMemoryTransport` 验证截图和 CUA metadata 消费，不是 mock 断言。
- `controller-owned-paths.json` 已明确 6 个 controller 文档路径，与 241 产品 scope 分离。

**保留边界**

- 旧 CLI/host bundle 中的旧 binding 不删除、不改写，继续标记为 prior build。
- shell 两个 `ZCODE_*` 名称仍由独立 `R20-shell-binding-aa3db-proposal` 跟踪，不纳入本轮 94 名称闭合。
- 未包含的 R22 全量失败、R48、Windows/CUA、正式 E2E、打包/签名和平台验收仍由各 owner 保留。
- 清理可在既有授权计划下继续，但与本次 scoped stage acceptance 分开；本结论不替代清理审计，也不声称正式发布通过。

**读取 Hash**

```text
61d3649eb732170e863bc13206db0358896feee98d3225b5d667cf908b3bbd27  implementation/source-hashes.json
db49792c4f36ff54ff6978f5ce5e97efef774ecd84b8c2af69bfbef87c616a29  implementation/execution-record.json
cf6fc8843fbb71f5cbae4d9cce2aecca98aabf47aa7d608ac8654c24c65f6953  reports/R20-bindings-closure.md
90df9317d36abcc3ca933de88ec4f00434543dc5cb49b3acf46116fc2bd3ac67  controller/final-evidence-verification.json
5b5f4079fb8613bb1e77c15cbba517b4235d614025ddac75ff94b1bbb3541e6c  controller/controller-owned-paths.json
213e4bcf079fd0ec1af0b355b78a27f26c75326e8ee56be7e0ed046985a06b5b  controller/source-audit.json
858f8dc4e3cde2e871aa1468fb657730c49fc686f766be120923af90db4bd65a  fresh-node-repl-host/server.mjs
```

本轮只读核对，未重跑测试、install、build、E2E，也未写文件。

