# macOS Computer Use Phase 1：正式资源装配与 JS 内容 TOCTOU 收尾

2026-10-30。**本轮两个限定 blocker 已关闭：正常桌面构建可装配已签名窄资源；cell 不再按已校验资源路径重新加载 JS。** 功能仍默认禁用，`zcodeCuaPlaceholder=true`。普通 Host 的截图激活未接入；完整 Computer Use 产品未验收、未发布。

## 范围、基线与委派

前轮 launchservices 源清单摘要 `11d49f9ff4303e3e1c7ed2dbcc9b5879227591f17be38201abd9451450c4d0eb`，76文件与开工工作区一致。已核对旧报告的来源、差分、构建、实测与许可材料，旧候选/冻结源/报告只读。新输出为 `output/cua-phase1-closeout/`，本目录为独立验收归档。没有 clean/reset、恢复已删除插件、覆盖其他任务的源改动或修改已安装应用。

先读取 AGENTS.md、mise.toml 和三项指定技能。shell未找到mise，使用已安装的 Node24.14.0绝对bin目录执行 freshness：main与origin/main同步，ahead32/behind0；架构基线0违规。desktop/zcode-cli受控context均为managed=false，架构gate不证明原生内部边界。

Broker实际route=`deepseek-flash`、name=`deepseek`、provider=`magpie`、model=`group/deepseek`。先routes，再授权本仓精确目录；两名只读调查worker、两名文件范围互斥的workspace-write实现worker，全部完成。无worker UI grant，无provider/model替换。完整worker ID见[evidence/workers.json](evidence/workers.json)。controller亲自审查相对opening快照的最终diff，并独立执行下列验证。

## A：正式构建路径的限定装配

实际桌面发行链为 `.github/workflows/zody-release.yml → packages/desktop/scripts/bundle.mjs → electron-builder.config.js`；顶层build:zody是另一条CLI/Web分发链，没有误接。新增构建期 `--cua-narrow-manifest <absolute path>` / `ZCODE_CUA_NARROW_MANIFEST`，无输入时保持原构建行为；显式空路径、错误目标、错摘要/身份或candidate Host seam均拒绝。仅支持本轮固定darwin arm64工件。

准备脚本从本轮已签名desktop-session Helper及native build manifest产生可整体搬迁的stage：Helper、pins、native manifest相对引用，固定代码中的证书/DR为信任根，不能由manifest自报新身份。固定入口/资源集合、Node CDHash、证书DER摘要、strict签名、HR、空entitlements、资源树与native entry摘要均校验。source/signed/unsigned摘要分开。controller将整个stage改名搬迁后，正式bundle dry-run复核通过。

正式包使用独立 `Resources/cua-narrow/Zody CUA Desktop Session.app`，未复用旧cua-helper槽、installer或producer。afterPack及afterSign再次核验，签名槽跳过sourcemap改写和重签。普通Host/CLI、PTY/SSH、remote路径未切换，未新增用户交互或授权状态。**候选Host缺少PTY/SSH，不能替代完整Host；普通Host实际截图需要另行对齐可信进程/协议。** 该差异已向用户解释，本轮未实施新结构。

首次正式electron-builder的窄资源复制/复核已通过，随后旧Koffi检查错误地要求placeholder树中已删除插件的原生文件，整包失败。按现行 `docs/desktop/computer-use-producer-detection.md` 恢复同一producer gate；真实producer缺资源仍失败，没有恢复插件或安装缺失模块。首次失败日志保留。

第二次 `electron-builder --mac --arm64 --dir` **exit0**，afterPack/afterSign均通过。实际产物为 `output/cua-phase1-closeout/normal-app/mac-arm64/Zody Preview.app`：复用当前正常JS out，使用正常配置的本机Preview flavor；未执行DMG/ZIP发布、生产flavor矩阵或普通Host完整功能验收。外层Electron仍不作为可信主体，可信的是保留原自签名身份的嵌套Helper/Node。正式包中的Helper字节与本轮实际截图候选一致，SHA-256=`a9fc07d84017a5b60c02a66cfd8e0a173bc01dbdc8270e345014e2548a53682e`，见[formal-package-audit.json](evidence/formal-package-audit.json)。

构建使用：

```sh
node packages/desktop/scripts/macos-cua-narrow-resources-prepare.mjs \
  --app <absolute-signed-desktop-session.app> \
  --native-build-manifest <absolute-build-manifest.json> \
  --output <absolute-stage-directory>
node packages/desktop/scripts/bundle.mjs --os mac --arch arm64 \
  --cua-narrow-manifest <absolute-stage-directory/manifest.json>
```

## B：校验内容直接进入 cell

已确认旧链：native辅助资源预检后关闭句柄；CLI再次读取并hash后丢弃bytes，只返回path；每次cell随后由Node重新打开path。校验后rename、原位改写或unlink/替换可改变执行内容。

新链在同一个O_NOFOLLOW/O_NONBLOCK句柄上检查regular/uid/mode、读取上限及增长、原始SHA-256和UTF-8无损性，捕获本次校验参数，保留不可变string。CUA factory构造时捕获快照，缺快照或启动覆盖直接拒绝。每次cell固定签名Node走 `--jitless --input-type=module - --zcode-node-repl-cell`，仅stdin携带快照；fd3请求/fd4结果、原per-call capability、owner/authority/turn/lease不变。源码不进argv/env/descriptor。普通MCP/SEA/Worker路径保持原语义。

stdin写入处理backpressure、EPIPE、提前close与abort，真实bundle仅在显式stdin-cell模式启动main；没有放宽普通import入口。中文注释说明修复依据。FIFO不在fstat前挂住；Windows跳过依赖POSIX uid的资源测试，未扩Windows验收。

controller使用真实server bundle及固定签名Node独立red/green：opening旧executor执行替换后未校验内容；新executor在rename、原位改写、unlink后均执行原bundle并返回42。探针server SHA-256=`6760e63ffa637f0e6c517b4cdd626de8228e94ad8908c767f62dd13808197fc2`，与本轮包内server完全一致。证据见[snapshot-probe/result.json](evidence/snapshot-probe/result.json)。B首批实现早于新回归文件落盘，controller据此退回补齐旧基线red/green；本记录不宣称严格tests-first的落盘顺序。

## 分层验证与实际调用

| 层次 | 本轮真实结果 |
| --- | --- |
| 根检查 | Node24.14.0下typecheck、lint、architecture通过；lint301warnings/0errors，架构0违规 |
| 相关CLI测试 | 7文件59项去重通过；先6文件55项，再追加writer/snapshot2文件11项（7项重复） |
| 资源/打包测试 | 4文件33项Node测试、4文件12项Vitest通过；node-repl包typecheck通过 |
| 编译链接 | 固定arm64/macOS14.2/SDK27及既有视觉静态库；未改全局工具链；3744个实际entry输入摘要最终无差异 |
| 签名/装配 | 现有local-self-signed；Helper/Node strict verify和正式包afterPack/afterSign复核通过 |
| 原生实际调用 | 新候选系统启动、真实单窗口截图、独立UI Stop通过；不等于普通Host截图激活或完整产品通过 |

没有改原生实现，原生6组测试未重复运行；前轮通过不冒充本轮新执行。没有新增证书、系统权限、entitlement、Developer ID或公证期限，没有关闭LV、DYLD覆盖、复制系统库或伪造Team ID。

新候选 `output/cua-phase1-closeout/controller-ui/Zody CUA Launchservices Candidate.app` 从系统入口启动；重新识别UI PID70018/PPID1、Host Helper70858/Node70876、CLI Helper70999/Node71019。只读窗口探针识别目标window88919，1200×800逻辑尺寸；未复用旧session的PID/window。OS tccd请求70999.2明确subject=`io.github.zclaudia.zody.cua-helper`、authValue2/authReason4，路径为新候选包内Helper，见[tcc-capture.log](evidence/independent-checks/tcc-capture.log)。

真实session=`sess_e7117241-7dc9-4223-8a14-45072757a8a5`。controller未代点原生允许；原生确认后截图成功，下载的工具返回JPEG已独立查看，见[实际返回图](evidence/independent-checks/actual-tool-closeout.jpg)。以下为UTC：

| 事件 | 事实 |
| --- | --- |
| 14:29:11.788 截图交付 | PNG2400×1600、454813bytes、SHA-256 `a21627c4503c7b30bb71c30b29d6b0cfd8de24749875dd63dbabfc5b42716ec4` |
| 截图lineage | `79e65ce0-ae56-4648-a3d2-20bcd1728135`；resourcesReleased=true、machineLeaseReleased=true |
| 随后30s等待 | 自然完成，controller错过Stop窗口，不算Stop通过，也未重复截图 |
| 独立取消lineage | `884f7e4e-f948-445f-8130-3569e6f547af`，真实UI Stop，非截图lineage |
| 14:31:45.740 → .753 | owner user-stop/revision2 → TOOL_CANCELLED，13ms |

工具JPEG为既有结果转换，2048×1365、147441bytes、SHA-256=`456a8fa7b83269546225bc22d0893fd0de1871c9a25ee1d36f439548ad51c111`，不与原生PNG混同。原生Helper AX绑定曾超时，未据此宣称观察到按钮或代为允许。截图与独立取消不冒充本轮同lineage截图→Stop证明；前轮同lineage证据保持原报告。完整事件见[live-summary.json](evidence/independent-checks/live-summary.json)。资源早已释放，不能据13ms取消声称在途原生屏障/native Fenced或所有后代退出。

## 来源与保留缺口

[evidence/source-and-patch.tar.gz](evidence/source-and-patch.tar.gz) 保存2369个源文件及相对opening的41文件差分，包含1974个实际workspace JS构建输入、必要builder/native来源；registry输入由逐文件摘要、锁文件与许可材料关联。源清单摘要见同目录source-sha256.json及SHA256.json，**这是源文件清单摘要，不是Rust冻结树摘要**。opening及change-origins区分前轮未提交内容与本轮新增。新native manifest、UI manifest、正式包audit及签名前后产物摘要分别保留。原始native manifest生成时仍带旧TOCTOU/保守hostLoad文案；实际entry摘要已覆盖修复，最终builder文案随后同步。原始记录不篡改，执行结论以源码图、真实探针及会话证据为准。

源清单SHA-256：`e705ec353195319854ed9ef4a540e2cf1cde1a583c1f8ae4d043eb2048876f9d`。

entry许可集合与前轮launchservices完全一致，仍有6项missing，见[license-comparison.json](evidence/independent-checks/license-comparison.json)及entry-audit-and-licenses.tar.gz；材料归档不等于法律采用通过。

仍未验收：普通Host实际截图激活；cell Node二进制仍按路径spawn、未增加cell PID loaded-code校验/消除二进制替换窗口；完整D06/OS隔离、输入native Fenced、所有后代退出保证；6项JS许可；Intel、最低macOS实机、升级后的身份/TCC稳定性。功能继续默认禁用，未新增成功stub或授权状态。
