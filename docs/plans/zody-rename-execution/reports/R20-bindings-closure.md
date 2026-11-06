# R20 内部 binding 闭包候选

基线 `aa3db87d8b9fa64be5f4fd027dac2681cdb414aa`；实施范围以控制器批准的 `R20-bindings-final-aa3db-proposal.json`（SHA-256 `8666b2cbdc9167d9e2020c60f5562a8c10de088a0edddcf8fb6520b08aa9b918`）为准。94 个内部声明、import/export、alias 和消费者按 AST 位置原子改为 `ZODY_*`，共 1,058 处精确替换或归档状态编辑，涉及 237 个既有路径；另新增对应 spec 与本报告。两项条件生成文件未变化。没有变更环境键、协议/错误/遥测值、插件身份与 metadata、数据路径和持久化字段；DWF 与 plugin-host 真实 argv 仍由各自 owner 处理。两个内部模块 mock export 键和三处源码文本测试断言随源名称同步；远程部署文档只改当前 binding 注释，历史分享文档仅变更顶部状态，其正文 SHA 与基线一致。

原 tsconfig 的 rootDir/outDir 与自定义 CompilerHost.writeFile 将 node-repl-host 的声明写到独占隔离目录；实际 emit 48 项、0 diagnostics，与基线逐字节比较 **48/48 相同**，包括 result 两项和 process-owner 的 control-only 两对，故没有提升任何 tracked 生成物。完整输出路径、摘要、诊断和比较见 `output/zody-rename-r20-bindings/implementation/node-host-staged-emit.json`。未执行会原位置覆盖这 48 项的默认 node-repl-host build。

定向重建 ignored contracts、core、adapters、telemetry、bootstrap 和 TUI 的包输出；按依赖消费顺序重新检查 16 个 CLI package dist 的 2,855 个 JS/声明文件，余下旧 binding 只在保留的旧 CLI `dist/zody.cjs` 和旧默认 node-repl-host `dist/mcp/server.js` bundle，二者继续标记为先前构建，不作为本阶段发行产物。Desktop main/host 及上述两个旧 bundle 前后 SHA 相同。官方 host bundler 另输出本任务隔离 `fresh-node-repl-host/server.mjs`（SHA-256 `858f8dc4e3cde2e871aa1468fb657730c49fc686f766be120923af90db4bd65a`）；实际 InMemoryTransport consumer 指向此文件，以合成请求验证截图与 CUA metadata 的原有外部键和响应。未重建或声称验证 R45 Desktop/Agent 正式发行产物。

固定 Node 24.14.0、pnpm 10.33.2，独占短 `/tmp` 与白名单子进程环境；CLI 工作区 19 个 package/tool 的直接 typecheck 均通过（逐包执行，避免 Turbo `^build` 隐式覆盖 tracked 声明）。直接受影响的现有 focused 验证通过：root 28 文件 662 测试、CLI adapters 3 文件 28、bootstrap 6 文件 229、core 2 文件 89、node-repl-host metadata 2 项、CLI node 174 项、TUI node 47 项，共 **1,231 项**。node-repl-host metadata 文件其余 21 项未运行；本批未运行 Desktop E2E 或发布构建。各条命令、父/子白名单环境、退出码和日志 hash 在 `output/zody-rename-r20-bindings/implementation/execution-record.json`，源码 hash 在 `source-hashes.json`。

保留的真实早期失败：CLI 第一轮旧 telemetry dist 导入已改名的旧 export、第二轮旧 bootstrap dist 同类错误；定向重建后真实 CLI 测试通过。隔离 host consumer 首次使用当前 Node 不支持的 `--experimental-default-type=module` 退出 9，改为输出独立 `.mjs` 后真实 consumer 通过；失败日志均保留。最初控制层 Python wrapper 自身继承 shell 环境，但 pnpm/node 被测进程树由显式 env 白名单启动；后续 wrapper 自重启进入白名单，并记录实际 wrapper 与 child env。macOS 可能在 exec 时附加 `__CF_USER_TEXT_ENCODING`，runner 在启动工作前移除控制层该项；未将早期记录改写为更强隔离证据。

独立 AST 对照、root typecheck/lint/changed architecture 与代码审查由控制器负责记录，不把本报告当作其替代。本候选已停写等待最终验收，未安装、创建 worktree 或清理共享缓存。
