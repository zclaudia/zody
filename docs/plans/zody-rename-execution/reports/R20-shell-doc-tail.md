# R20 shell 与历史文档尾项

基线 `e55cda50c6c4ef2be3af38148fc780e159db6960`。macOS release doctor 仅改两个脚本内部 binding：`ZCODE_HOME_DIR` → `ZODY_DOCTOR_HOME_DIR`、`ZCODE_HOME_HELPER_APP_PATH` → `ZODY_DOCTOR_HOME_HELPER_APP_PATH`。`ZODY_HOME`/`HOME/.zody`、`ZODY_CUA_HELPER_APP_PATH` 优先级、Helper 名称和验签行为不变；未增加 export/unset。调用者若预先导出旧变量，新脚本不再覆盖其值，未发现外部消费者；Bash 仍保留预导出同名新变量的 export 属性。

Desktop CI/CD 与 macOS 公证文档顶部标明所述旧 GitLab/公证脚本已不在本仓，并单列可核实的 doctor 输入；历史正文保留。Preview 设计文档标历史范围，仅把 doctor 行现判据改为实际 `ZODY_ENV=test` 或 `ZODY_PREVIEW_IDENTITY=1`，原判据保留。不存在的 CI/公证流程未被描述为当前可执行。

固定 Node 24.14.0、pnpm 10.33.2，在独立白名单 HOME/USERPROFILE/TMP/XDG 进程环境中：freshness exit 0（ahead 94、behind 0），基线 `architecture:check --changed` exit 0、0 violations；`bash -n` exit 0；现有 fake-tool `macosReleaseAppDoctor.test.ts` 1 file / 9 tests exit 0。命令、环境、退出码及日志位于 `output/zody-rename-r20-shell-doc-tail/`。没有使用真实 app、codesign、spctl 或 notarization。根 typecheck/lint/最终 architecture 由主控在停写后执行，本报告不预称结果。

本阶段隔离临时根和日志保留待独立审查与验收后的精确清理；没有安装依赖或新建 worktree。

同脚本两条当前说明注释已同步：Preview 判断只描述脚本自身的精确 `1` 比较，Helper 常量路径与现行测试的 `@zody/zody-cua/broker/helperConstants` 导入一致；仅注释变更，没有重复运行 fake-tool 测试。初始六路径哈希保留在 `source-hashes-initial.json`。
