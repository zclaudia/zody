# macOS Computer Use Phase 1：正式装配与 cell 资源收尾

2026-10-30。基线：launchservices 源清单摘要 `11d49f9ff4303e3e1c7ed2dbcc9b5879227591f17be38201abd9451450c4d0eb`，76 文件与开工工作区完全一致。Node 24.14.0 freshness、architecture 基线通过。旧材料只读；输出 `output/cua-phase1-closeout/`，独立验收目录 `reports/2026-10-30-closeout/`。

## 调查与实现边界

A：调查正常 desktop `bundle`/electron-builder 的构建、资源、签名路径；顶层 `build:zody` 是另外的 CLI/server 发行入口，不能凭名称误接。普通 Host 保持现有完整能力，不能套用 candidate throw-only PTY/SSH shim。已确认先做独立 cua-narrow 槽位的签名资源装配、默认不激活；不触碰普通 Host 路由。普通 Host 实际截图需新增启动协议，已向用户列明差异，等待范围对齐；与此无关的资源准备及 B 继续。

B：已确认 `entries/cli-entry.ts` 校验句柄的 bytes 后仅返回 path，`subprocess-launch.ts` 随后让 Node 再开 path，存在替换竞态。先更新规格/验收，再交 DeepSeek 修改 CLI composition 与 node-repl-host，测试先于实现。修复使用同份校验内容的 stdin ESM 快照，fd3/4 与原 owner/capability 保持，不扩 D06。

调查 worker 与后续实现 worker ID 均写 `output/cua-phase1-closeout/workers.json`。普通开发不授 UI。并发 writers 文件范围互斥；controller 不修改 worker 所属实现文件。

## 必要验证

controller 审查相对本轮 opening snapshot 的差分，独立执行根 typecheck/lint/architecture、受影响资源/构建和 subprocess/CUA 端口测试；用固定工具链独立构建签名 Helper，并执行真实 server 快照子进程探针及与装配变化有关的单窗口截图。编译链接、模拟测试、真实原生调用、产品验收分别记账，保持默认禁用与 placeholder。

完整 D06、输入 native Fenced、后代全退出、六项 JS 许可 missing、Intel/最低 OS/升级身份 TCC 均继续未验收；不扩大矩阵。保留所有前轮及其他任务未提交改动，源码/差分/构建和实测证据归档到本轮新目录。

## 当前独立验收进度

B 实现已由 DeepSeek 完成并冻结，controller 对 opening旧executor/新真实bundle和固定签名Node做red/green：旧路径执行替换字节；新快照在rename/原位改写/unlink后均执行原bundle。6组55项与追加writer/snapshot两组11项通过（去重7文件59项），根typecheck和node-repl包typecheck通过。

新helper独立编译链接、固定证书签名与包内strict verify通过，3744个entry构建输入摘要与当前源码一致。新候选经系统入口启动，实际截图2400×1600成功，原生PNG摘要 `a21627c4503c7b30bb71c30b29d6b0cfd8de24749875dd63dbabfc5b42716ec4`，资源和machine lease交付前释放；OS TCC subject为包内同Helper。截图后的30s等待自然完成，未算Stop通过。随后不再截图的独立UI Stop回归owner撤销到TOOL_CANCELLED=13ms；与截图不同lineage，不能写成新二进制同lineage截图→Stop或native Fenced。

A收敛过程中补齐独立签名槽、身份/内容复核、可搬迁stage、sourcemap后处理保护。初次根lint因新增实现和测试超过400行出现2errors/302warnings；DeepSeek随后拆分，controller最终重跑通过。首次失败保留。

正式electron-builder第一次实际打包已通过新cua-narrow复制及签名/摘要复核，之后被原有Koffi校验阻断。`docs/desktop/computer-use-producer-detection.md` 已规定仅真实producer才执行专属资源检查；当前placeholder仍要求已删除`zcode-cua-plugin`的koffi，属于既有规则回归。本轮允许最小恢复同一producer gate，先补placeholder跳过/real缺资源失败回归，不恢复插件、不增加fallback，controller重跑正式装配。首次失败留档。

## 最终结果

A 资源装配与 B JS 内容 TOCTOU 已关闭。正式desktop bundle/electron-builder支持显式可搬迁manifest，独立cua-narrow槽在afterPack/afterSign复核，普通Host路由、PTY/SSH及placeholder不变。Koffi检查按现行producer规则恢复gate，真实producer缺资源仍失败。第二次electron-builder --dir在当前Preview flavor下成功；复用现有正常JS out，未执行DMG/ZIP发布和普通Host截图激活。第一轮失败日志仍保留。

controller最终根typecheck、lint（301warnings/0errors）、architecture均通过；node-repl包typecheck通过。7文件59项CLI相关测试（55与追加11的去重值），4文件12项打包回归，4文件33项资源装配回归通过。编译链接、已签名Helper真实截图及独立UIStop均分别记录；原生6组未因未改native源码重复运行，前轮结果不冒充本轮新执行。entry许可集合与launchservices完全一致，6项missing保留。

最终报告及源码/patch/构建/实测证据见[本轮验收](../../packages/desktop/native/macos-cua-driver-closure/reports/2026-10-30-closeout/ACCEPTANCE.md)。普通Host实际截图需要后续进程/协议对齐，当前不改变该结构；固定cell Node仍按路径spawn，无cell loaded-code新保证；完整D06、native Fenced、后代全退出、Intel/最低OS/升级身份TCC、法律采用均未验收。
