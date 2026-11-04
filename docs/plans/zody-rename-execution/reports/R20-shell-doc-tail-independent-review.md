# Independent shell/doc tail acceptance

**判定**
SCOPED ACCEPTANCE: **PASS**。未发现需要阻断的代码或证据问题；可按当前范围进入清理。此结论仅覆盖 R20 shell/doc tail，不表示全 R20、全 CI、R30 或发行验收通过。

**代码范围**
- `scripts/doctor-macos-release-app.sh` 仅有两处 binding 改名及对应展开：`:6`、`:23-24`；外部 `ZODY_HOME`、`ZODY_CUA_HELPER_APP_PATH`、Helper 名称/路径与检查行为未改。
- Addendum 仅改两条注释：`:9` 的 `resolve_zcode_env` 过时说明、`:22` 的包名说明；`@zody/zody-cua/broker/helperConstants` 与当前包名及测试导入一致。
- 非注释脚本字节验证通过：基线经两条名称映射后的 SHA 与当前非注释内容均为 `31001241c58c3e4fab8f4de4522dbc3a5b0148b0ed095c6e596752f3c2712a79`，说明没有额外可执行变更。
- 三份文档 diff 仅为授权变更：CI/公证文档顶部各加 2 行归档说明；Preview 文档顶部加历史范围说明并只改 `:277` doctor 当前列，原 `ZCODE_ENV=test` 列和其他历史正文保留；`specs/zody-rename-internal-bindings.md` 仅新增内部 binding 契约段落。

**证据**
- `source-hashes.json` 的 6 个路径 SHA 与当前文件逐一匹配；`source-hashes-initial.json` 仅脚本/report 因 comments-only addendum 变化，符合记录。
- `controller/results.json`：9/9 doctor tests、root typecheck/lint/architecture 均 exit 0、lint 303 warnings；7 个日志 SHA 全部复核匹配。
- `bash -n` exit 0；freshness ahead 94/behind 0；architecture 0 violations；doctor fake-tool 9/9。
- 归档声明可核实：当前仓库无 `.gitlab-ci.yml`、无 `scripts/notarize-macos.sh`。

**边界**
- `docs/plans/zody-rename-execution/file-assignments.json` 的修改属 controller 状态，不纳入本次 Terra 六路径验收；`task-ledger.md` 未改。
- 报告已保留，清理尚未执行；未真实签名、公证、启动 app、安装或新建 worktree。

