# R22 6fb 固定候选构建和宿主验证

源码 commit `6fb79b35dd715d7d42ecbca46681541e293d652d`、tree `7363415f380d62f36bd3b93d8e886cf3575fda30`。沿用 9d 首次安装及 6c frozen reinstall，非 6fb 新空安装。固定树 typecheck 0、CLI force build 23/23、0 cache；原两个缺 dist 的 root tests 7/7；15 collectors 通过。各阶段独立目录 `final-6fb-prerequisites`、`final-6fb-consumer`、`final-6fb-collectors` 留完整命令/状态。真实构建 `final-6fb-distribution` 四目标 exit 0，未用 skip-build，归档 SHA256SUMS 和各 sidecar 均实算通过：

- darwin-arm64 `1d24c86cf63e6aa108777fd69c64cab386bfabfc1e207d036840d9e323b2bc78`
- darwin-x64 `446b1415565c122ab9fdc34fe9ec837acd3a95ac9f35df191650ac0c1056049a`
- win32-x64 `593768b66292b225e54f0c6bdc4f78c7a5c7933ce2024ca4824563fde334ca58`
- linux-x64 `05ae467061dc3f9a35e2a0bfa9cf05131df86cd20b35c3eca2d3064b37dccf34`

四目标最终 official SEA manifests 均包含 browser-use/package.json SHA `c23ae067cc194f18af8953ef4e5d671d4b127092e15d4c10c3721a998bbedd91`，完整位置与 manifest hash 在 `final-6fb-distribution/official-manifests.json`。

本目录实际 darwin-arm64 归档 smoke exit 0：TUI native import、渲染与键盘退出，本地 Web HTML/server-info/workspace/WebSocket 和关闭通过；归档 launcher 与 SEA `--version` 均 0.1.0。归档 provider 与生产输入 SHA 均 `bba4a742c493667c4b463a9e57ff8027563406391d8f0d671935c5f846052999`，source.read 实际读取成功，两份 provider 测试 4/4。无在线 provider、真实用户数据或正式签名；其他架构未执行。任务路径关联进程检查 0，tracked Git clean。

宿主归档 package 实测 `verificationOnly=true`、`reviewObligationCount=19`；strict 仍不通过，不具发布结论。内部 `dist/zcode-<target>` 交 R45，外部归档及 launcher 使用 zody。Darwin SEA 仅本机 ad-hoc 签名，不等于正式发布签名或 Desktop 发行。

Controller independently recomputed all four archive hashes and checked every sidecar and SHA256SUMS entry: output/zody-rename-r22/metadata-tail-controller/archive-hashes-6fb.json. Exact6fb agent snapshot (zody.cjs SHA eda9da94904c506b6fb6752685e627668eca0c40ea01682908c5ac23283f38ac) is handed to the separately authorized server-cli bridge stage verification, with provenance manifest under server-cli-bridge/inputs-6fb. It does not prove that separate entry already starts.
