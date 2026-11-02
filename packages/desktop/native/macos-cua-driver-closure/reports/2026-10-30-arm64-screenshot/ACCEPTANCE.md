# macOS CUA Phase 1 arm64 单窗口截图收尾记录

记录时间：2026-10-31（Asia/Shanghai；构建日志为 2026-10-30 UTC）。结论：**实现与正式资源装配已完成；本轮产品验收未通过，等待解锁和磁盘空间后继续。** 功能保持默认禁用，`zcodeCuaPlaceholder=true`。没有切换证书、扩大 TCC 权限或启用 Developer ID/公证。

本轮接受的边界是：完整普通 Electron utility Host 保留 PTY/SSH/remote，仅作为不受信传输与来源分类层；已存在的唯一 Agent 经 Helper `workspace-relay` 接入 signed Node sealed CLI，同一 CLI Helper 接管暂停启动的 cell。继续复用 CommandInbox、CuaSubmissionAuthority、authority、lease、frame owner。**普通 Host 可以伪造 desktop 来源的缺口明确保留**，实际采集仍需用户逐次原生确认。没有新增截图 runtime、第二套授权状态或用户交互。

## 已完成与尚不能关闭的 blocker

| 项目 | 本轮事实 | 关闭边界 |
| --- | --- | --- |
| 正式构建资源装配 | 正式 electron-builder `--dir` PASS；固定 Helper.app 与经真实校验的原 manifest 精确 bytes 进入 `Resources/cua-narrow/`；afterPack/afterSign live codesign、tree、manifest 校验均 PASS | 资源装配 blocker 已关闭；不等于正常 Host 产品截图已验收 |
| 普通 Host 接线 | 启动 resolver、固定构建 profile、workspace/OS/arch/resource/provider/network 比对与普通 Agent fallback 实现；普通 Host 和服务相关 130 项独立测试通过 | 新独立 UI 候选尚未装配完成；复制 Electron Framework 时 ENOSPC，未启动，不能关闭产品接线 blocker |
| hash/exec TOCTOU 与 cell 身份 | Helper 以 START_SUSPENDED 创建真实 Node PID，先验证实际 loaded DR/CDHash/空 entitlements，再 SIGCONT、写入固定 server 源快照，最后才释放请求与 capability；不再按可变 server 路径 exec | 基础 signed Node 正例与 unsigned 映像负例已独立实测；生产 cell 实际请求、身份日志、回收仍待产品链实测，不宣称完整 D06 |
| 同 UID 假端点 | cell 与 authority socket 使用仅经私有 fd3 注入的瞬时 256-bit key + 每连接 challenge 的固定角色 HMAC proof；服务端仍核验自己 CLI 的 kernel PID/loaded code；proof 前不发送 CellRequest/cap 或 scope/ref | 真实 Unix socket、重放/跨角色/边界和失败路径测试通过；不是新的业务授权 owner；真实 key 不写入日志或归档 |
| 在途截图 Stop | capture owner 先撤销准入，补偿发布竞态，取消并丢弃迟到图像；Swift 使用真实 one-shot SCScreenshotManager completion mailbox，释放图片引用后才报告释放；unknown 保留债务 | fake visual native harness 6 场景与构建通过；**新实际 completion 持有期间的同 lineage UI Stop 未运行**，该 blocker 继续开放 |

构建 opt-in 仅在新 Agent spawn 时选择一次。默认模型/provider/network 读回与 profile 严格匹配；不匹配或读取失败保留原普通 Agent、CUA 不可用。后续 task override、运行中模型/provider 修改、完整 CLI/WASM/proxy/custom-CA 兼容性仍未证明。native/Helper 中继只采用已有 MCP 30 分钟上限，实际默认工具预算仍为 600 秒，由原 AbortSignal 控制。

## 独立验证分账

| 层次 | controller 实际执行 | 结果 |
| --- | --- | --- |
| 根检查 | pinned Node 24.14.0；pnpm typecheck、pnpm lint、pnpm architecture:check --changed、git diff --check | PASS；lint 301 warnings / 0 errors，architecture 0 violations / baseline 0 / new 0 |
| TypeScript/Node 测试 | Host 6 文件 130 项，另补新增 3 项构建证据回归；cell 5 文件 66 项；narrow resource 35 项；Stop 编排 15 项；CLI node:test 10 项；shared proof 7 项 | 原 263 项与新增 3 项回归均 PASS（末次 Host 3 文件 28 项含重叠旧用例，不重复计数）；最终命令、退出状态、日志均保存。原 socket 测试 close(hadError) 的断言问题已由 DeepSeek 修正并独立复跑；node:test 文件曾误投 Vitest 的失败也保留 |
| 编译/链接 | production/diagnostic visual 各自构建；Rust 每套 46 项；production Helper 编译链接及 10 个 native 测试程序；diagnostic 使用相同 native source，未重复跑 native 测试 | PASS。编译不是产品验收。两套 JS 构建输入摘要一致，但 bundle 输出有 use-strict 指令位置差异，逐件记录不同摘要，不宣称 byte-identical |
| native 模拟 | 真实 capture_owner/AuthorityClient/MachineLease + fake visual ABI，6 个 Stop/竞态/unknown 场景 | PASS；明确为模拟，不能替代 OS completion 或真实截图 |
| 实际 native 基础探针 | 本机 macOS 26.6.2 arm64；signed Node 先暂停，实际 DR/CDHash/空 entitlements 通过后恢复，stdout 42、exit 0/reap；unsigned 映像拒绝，无 SIGCONT/stdin，kill/reap、marker 不存在 | PASS，仅此基础正负例；错 certificate/错 DR/非空 entitlements 未分别扩测 |
| 签名与装配 | production/diagnostic Helper 使用既有 local-self-signed；真实 prepare-narrow 校验；正式 electron-builder 路径 afterPack/afterSign 校验 | PASS。外层 Electron 为明确 unsigned 测试配置，包内 Helper/Node 保留固定身份；没有 ad-hoc 冒充可信身份 |
| 本轮产品 | 正常 Host 配置读回与最终匹配候选、生产 cell 调用、单窗口截图、在途 UI Stop、callback/图片释放和 OS lease 重获 | **NOT RUN / BLOCKED**，Mac 锁定且候选复制 ENOSPC；没有展示原生确认弹窗，没有复用上一 session PID/window ID/截图/Stop |

未扩大 Intel、最低 macOS、升级身份/TCC、输入 native Fenced、完整 D06、所有后代退出矩阵。完整 D06/OS 隔离与所有后代退出保证继续开放；签名 Node 身份校验不等于模型代码 OS 隔离。CLI 许可审计仍有 6 条 missing（含重复包记录），归档不代表法律采用通过。

## 普通 Host 源码编译与最后修复

controller 在 UI 装配受阻后单独执行相同 main/host/scheduler 源码编译：三组先通过，但首次 evidence writer 将 esbuild `<define:NAME>` 虚拟输入误作文件路径，报 ENOENT。先补 spec 与验收合同，DeepSeek 补 red/green 回归，再修复证据分类；controller 独立复跑三组编译与完整 evidence writer，均 PASS。915 个去重仓库源码输入与最终冻结内容一致，3 个 generated expression 只保存 name/精确 expression SHA256/UTF-8 bytes；未知 virtual 或缺少 supplied define 一律失败，不保存原始表达式/秘密。该编译采用明确的 readback seed，**不表示实际模型 profile 合格或完整 app 已装配**。

修复后再跑根 typecheck、lint（301 warnings/0 errors）、architecture（0 violations）与相关 28 项测试，均通过。最初冻结目录 `frozen-arm64-screenshot/` 与清单 `fe019fc617d4980edf1480e0c4a360b99fbfcb2f4d5fb9ab1fba99d917b02e10` 保留；最终冻结目录另建 `frozen-arm64-screenshot-final/`。初版 source/validation 压缩包保留为 `*.initial.tar.gz`，最终版本用标准文件名，并由 evidence-sha256.json 统一核对。

## 来源、审查与产物

旧 launchservices `source-sha256.json` 仍为 `11d49f9ff4303e3e1c7ed2dbcc9b5879227591f17be38201abd9451450c4d0eb`，没有修改旧冻结树、报告或旧输出。开工时 2369 个来源文件与上一轮清单一致；已有 dirty working tree 与额外读取时点由 opening/additional 证据分开保存。所有实现由已核实的 Broker route `deepseek-flash`（name deepseek；实际 provider `magpie`、model `group/deepseek`）完成；controller 未替换 provider/model，独立审查增量 diff 和高风险链路并运行上述验证。worker ID、文件边界及补充授权见 evidence/workers.json；普通 worker 无 UI grant。

本轮冻结源码：`output/cua-arm64-screenshot/frozen-arm64-screenshot-final/`。**4269 个来源/上下文文件的清单 SHA256 为 `27ec8b1a846f2730e01cc9ed13bf137a47dd67a1edf4d55c21e62d7844f6b7df`；这是源文件清单摘要，不是 Rust 树摘要。** `incremental.patch` 优先对开工 preimage；部分文件使用工作中 additional preimage，change-index 明确标注，不能把这部分 patch 单独当作完整开工差分。最终完整源码、开工 dirty diff、preimage、输入摘要一并归档；生成的 dist-types 不作为新增实现。Helper 两套 native 34 文件分别与最终源码核对，0 mismatch；生产 JS 仓库输入核对 6047 条（含跨入口重复）0 mismatch。

| 可复核产物 | 摘要/状态 |
| --- | --- |
| production signed Helper executable | `8cedd3d4ce79deea8449cd838f70068eba4bc924580749619c9cb72050c94515` |
| diagnostic signed Helper executable | `4b31561c5f00c8d007c7a13a6c29fb026ffab5220efebaa74da72599b5e943b0` |
| Node（两套相同） | `14931ecd0d332e1e968172964445ec69557fded6969ad31a86ac0a8e0f4d3dcf`；CDHash `3c57a9bb9f4e8b748ac80d60bc78cdde14767218` |
| production prepared manifest | `3b059dfb06507bc2ca1966f5bba5476cbae96ec4356e0fe588b3fc892f0b0cfb` |
| diagnostic prepared manifest | `c1501abc407edef6c3b5398a9b32bfce28466cc5554a097dc9ca3d885dbe995e` |
| production visual staticlib | `d57549a53bffc6ac17788d6ace2b8bfe7df9b3a85db54b2f42c837b5812d7910` |
| diagnostic visual staticlib | `b2162ccbb1e33985a2ebdecab8b8f4cb8f8af0f1719f3bb424c9c535f410bdba` |

成功的正式资源包在 `output/cua-arm64-screenshot/controller-formal-production/mac-arm64/Zody Preview.app`。它是正式资源装配证据，尚不是完成 opt-in 的独立普通 Host 产品候选；不要把该包当成已验收截图版。独立 identity/profile/readback 构建入口是 `packages/desktop/scripts/build-cua-normal-host-candidate.mjs`；`startup-readback-seed.json` 明确为全零摘要的 readback seed，**不是已测模型配置**，不作为资格证明，也未触发任何模型调用。真实启动读回后还需重新 pin profile。

## 环境事故及恢复

Host worker 曾错误使用 asar `extract-file ... package.json`，该 CLI 写 cwd 文件而非 stdout，覆盖根 package.json；随后错误选择 pnpm 12 并扰动锁文件/依赖。controller 中止相关 worker，以开工 preimage 和 SHA guard 恢复根 package.json 与原 dirty lock。只为既有 node-repl-host 的依赖分类差异移动 6 行 importer 条目，无版本/分辨率变更，补丁单独保存。根 package.json 现为 `9fa285d4d3d3e96f22f8f54fc88073c9b69f3f4051ebedc711d4190d25d523c8`；lock 为 `50a8835f57ee9ffbf7a06c09f7c514fc37d9e4ae3aef2730fbafd4980a1efc6a`。后续每条检查均先核验这两个摘要。

使用 pinned pnpm 10.33.2 frozen install 恢复依赖，并清理 323 个确认失效、指向已不存在 `.pnpm` 的 workspace 依赖链接；旧 bin shim 隔离保留，再 frozen relink。没有 clean/reset/回滚源码；没有删除其他任务的源文件或未提交改动。新增 asar Buffer API/cwd sentinel 测试防止再次覆盖 cwd。

磁盘不足先后影响暂存与候选复制；只移除了本轮可重建失败/过期 app、Rust cache、被 controller 独立产物替代的 worker staticlib，日志/源码/manifest/摘要和 controller 最终静态库保留。等字节的本轮副本使用 APFS clone 节省空间；只读旧包仅作为相同字节的读取来源。ASAR 早前 missing-next 两次失败的确切原因未证，最终 child audit 中 ASAR 子进程 status 均 0 且正式构建 PASS，不把早期失败隐藏或武断归因为 OOM。

## 下一步所需条件与同范围验收

已经向用户请求手动解锁并释放至少 4 GB；当前只能确认 API 报 locked、候选复制报 ENOSPC，不能自动把等待当成授权或成功。条件满足后继续：重新识别当前进程/窗口 → 完成独立普通 Host readback 候选并读取非秘密 startup snapshot → 固定实际已测配置重建 → 单窗口真实截图（原生确认弹出即通知用户点击）→ diagnostic 真实 completion-held 时 UI Stop → 分别核实同 lineage 撤销、TOOL_CANCELLED、实际 callback/image release 与固定 OS machine lease 重新获得。生产默认无 diagnostic gate，不声称 OS 内部取消/native Fenced/全部后代退出。

本报告是当前阶段的可复核交付，不是 Phase 1 通过结论；上述产品项完成前不得默认启用。
