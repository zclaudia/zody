# macOS CUA arm64 产品阶段验收记录（2026-10-31）

状态：部分验收完成，Stop 待原生确认（2026-10-31）。实现已落盘；产品生产 UI + PNG 正例已实测（1172x976），native audit 实现与独立测试完成；但本报告写定时 native click 未取得、completion-held Stop 未执行，故 Stop 与完整产品验收仍 PENDING。功能默认禁用（`zcodeCuaPlaceholder: true`、`productDefaultDisabled: true`）。本报告记录部分实测、源冻结和保留缺口，不构成完整产品验收通过。

## 审计边界

- 本报告只写新目录 `reports/2026-10-31-arm64-screenshot-product/`；旧报告、冻结源与旧 output 只读。
- 产品阶段证据根：`output/cua-arm64-screenshot-product/`；构建 `.app` 保留在 output，源码按清单归档；未归档 `~/.zody` 整库、凭据或传输认证 key。
- ordinary Host 仍是不受信 transport，`inputOrigin` 不能抵御被篡改的 Host；实际截图仍由固定签名 Helper 强制逐次原生确认，并复用既有 authority/lease。该来源可信性缺口保持 OPEN。

### Worker ownership 与验证层级

实际 Broker 路由为 `deepseek-flash`（name `deepseek`，provider `magpie`，model `group/deepseek`，backend `app_server`），已由 `routes` 返回核实；未替换 controller provider/model。普通开发无 UI grant。完整派发记录见 `broker-dispatch-provenance.json`。

| 范围 | 实际 Broker worker ID |
| --- | --- |
| Host 装配、packaging、native audit | `broker:deepseek-flash-rw-ec6bf2fd7be1a108:01a18d85-0a94-7153-8dec-4d8ce186ab96` |
| 前轮 cell 修复 | `broker:deepseek-flash-rw-ec6bf2fd7be1a108:01a18d85-b240-7390-875a-7fd2a92d04ad` |
| 前轮 Stop 修复 | `broker:deepseek-flash-rw-ec6bf2fd7be1a108:01a18d86-25a4-7961-bb9e-18f16365c014` |
| spec、计划、报告 | `broker:deepseek-flash-rw-ec6bf2fd7be1a108:01a18d81-c662-7252-bf8e-dc961bb1e948` |

Controller 亲自审查最终源码/diff，独立执行本轮检查和实测；前轮 Host 130、cell 66、narrow Node 35、Stop 15 等历史检查引用前轮 `2026-10-30-arm64-screenshot/ACCEPTANCE.md`，不计作本轮重跑。本轮新执行为 packaging 27 项和 native audit/ProcessManager 150 项。

| 验证层级 | 内容 | 当前记录 |
| --- | --- | --- |
| L1 静态 / 单元 | typecheck、lint、architecture、packaging tests、native audit tests | 通过；`desktop/services/zcode-cli` 为 `managed:false`，arch 0 不证明 unmanaged runtime 边界 |
| L2 构建 / 包装 | formal production/diagnostic、candidate builds、签名/资源与 ASAR 核对 | 通过；最新 production-audit build PASS 30.511s，未启动；outer Electron 仍为 unsigned test config |
| L3 真实原生启动 / 身份 | production PIDs/TCC、diagnostic-audit PIDs、suspended cell 990 与独立 loaded OS probe | 通过；actual arm64 macOS 26.6.2（25G83）/Node 24.14.0；负例仍仅 unsigned 映像 |
| L4 真实 OS 截图 / Stop | production UI + PNG；diagnostic attempt #1 的 native confirmation/Stop | 先前 production PNG 成功；最新 production-audit 未启动/无新截图；attempt #1 timeout 不是 Stop；Stop PENDING |

## 分层结果

| 层次 | 实际证据 | 记录结论 | 未证明 / 缺口 |
| --- | --- | --- | --- |
| 编译 / 链接 | `pnpm typecheck` exit 0；formal production 与 diagnostic `electron-builder --dir` 均 exit 0；最新 `controller-normal-host-production-audit` 以 production manifest 重建 PASS `30.511s`，未启动；diagnostic-audit candidate build exit 0、`39.925s`；最新 production-audit 与 diagnostic-audit build input 独立 hash 核对为 2091 个 workspace input 引用、916 distinct、0 mismatch，7 个 virtual esbuild define 另行记账；candidate main/host/scheduler 为 workspace source 编译产物；四个既有 Chromium Helper 的 bundle/executable 已按候选父名前缀重命名；固定 Helper/Node 的 `codesign` 为 valid 且满足 DR，最新 diagnostic Helper/Node strict pass hashes 保持 `4b3156…`/`14931e…` 不变；本轮 native compile 仅为 independent target/loaded probe（两个 probe 均 exit 0） | 类型检查与打包装配通过；固定 Helper/Node 身份校验通过；independent probe 编译通过 | 本轮 native compile 不是 product native compile，不记 product native compile/link 通过；outer Electron 为 `builderSigned:false` 测试配置，非正式签名产品 |
| 测试 / 模拟 | 前轮独立 Host 130、cell 66、narrow Node 35、Stop 15 项通过（历史引用，非本轮重跑）；packaging 5 个测试文件、27 项全部通过；native audit 独立测试 2 个文件、150 项通过（84 parser + 66 ProcessManager）；CLI `node:test` 与 shared auth 早期通过；typecheck exit 0；lint exit 0，301 warnings / 0 errors；architecture 0 violations；freshness 由 root/controller 记录通过（产品目录未单列 freshness 日志） | 单元/静态检查通过；native audit strict schema 由 controller 复核 | `desktop/services/zcode-cli` policy 为 `managed:false`，architecture 0 不证明 unmanaged runtime 边界；root diff review 另记；不替代真实原生调用或产品验收 |
| 真实原生（启动 / 身份 / TCC） | 先前 production 候选系统启动：main `79594`、Host `80007`、CLI Helper `80104`、signed Node `80108`；启动快照匹配 `DeepSeek/deepseek-flash`、reasoning `max`；TCC 过滤日志显示实际发送者 `80104` 与 `io.github.zclaudia.zody.cua-helper`；measured platform 为实际 arm64 macOS 26.6.2（25G83）、Node 24.14.0 | ordinary Host 窄链真实启动且 Helper/TCC 归属可观察 | 最新 `controller-normal-host-production-audit` 未启动，不能把其 build/log 增量当作新 production run；旧生产 run 的 debug stderr 已由 native audit strict schema 修复；audit 事件仍是 operational self-report，不是身份/授权证明，直接 SecCode 独立证据另列 |
| 真实原生（截图） | 通过 UI 得到实际图片，独立查看并下载：`production-tool-image.png`，1172x976，108925 bytes，SHA-256 `e1bca9e1d32237e21bb07ad1e8655268fbab04557d87d330c14112ed062d523e`；受控 TextEdit 文档窗口 `CUA arm64 acceptance 2026-10-31.rtf`；工具事件显示 provider `deepseek` / `deepseek-flash`，成功 tool call 耗时 4193ms | 存在一张真实单窗口产品截图；对应 session/tool lineage 已由 readonly usage 与 CLI turn events 对齐 | 首个正确截图请求在用户点击前 120 秒超时（`ProtocolError 23`），明确不记通过；首个 Bash 工具调用为 `permission_denied`，未执行；后续重试 turn 约 7.5 秒、tool 4.193 秒完成 |
| 真实原生（诊断审计 #1） | diagnostic-audit candidate build 39.925s；actual main `99745`、Host `264`、Helper `350`、signed CLI `360`；system entry AX URL 使用新路径；startup 匹配同一 DeepSeek 快照；latest diagnostic Helper/Node strict codesign pass hashes unchanged `4b3156…`/`14931e…`；cell `990` 于 12:21:33.717 suspended，12:21:33.730 loaded verified 后 resume；source 3,575,522 bytes；独立 `SecCodeCopyGuest` 严格 leaf DR/SecCode 身份经 controller 复核 | 真实 suspended cell 正例通过；独立 loaded OS probe 通过 | native confirmation 12:21:34.499 后用户 120s 未点击；12:23:32.928 timeout `authority-eof`、`allowed:false`；cell SIGKILL/reaped；capture-rejected `connection-failed`；无 actual OS completion/UIStop，Stop PENDING |
| 产品验收 | 先前的真实图片、启动身份与 TCC 事实已记录；最新 production-audit 仅以 production manifest 重建 PASS 30.511s，未启动且无新截图；功能仍默认禁用；accepted Host 可伪造来源的缺口 OPEN | **部分验收完成 / Stop 待原生确认 / 未完整接受** | native audit strict schema 已 complete 并通过 150 项独立测试；在途 Stop 尚未执行，attempt #1 timeout 不是 Stop；不得据此声称产品验收通过 |

### 生产证据补充

- `production-tool-usage-readonly.json` 与 `production-cli-turn-tool-events.jsonl` 对齐同一 `sess_5c136762-0d5b-4d36-960a-1d4ac7ebf269`；成功工具位于 `turn_2934f089…` / `call_00_w5pJOBIHXqMfQghU4w6L1346`，`mcp__node_repl__js` 状态 `completed`，`duration_ms: 4193`。首个 Bash 调用 `permission_denied`，未执行；首个截图调用 `ProtocolError 23`、`duration_ms: 120033`，不计成功。
- `production-lease-independent-after.json` 记录独立进程在 Helper `80104` 仍存活时，对 inode `149745182` 的锁文件直接执行 non-blocking `flock`，结果为 `acquired-and-immediately-unlocked`。
- `production-quit-observation.json` 记录 CUA application `super+q` 后 main/Host/Helper/Node 四个 PID `79594/80007/80104/80108` 均不再存在；明确 `noAllDescendantsClaim: true`，不据此声明 all-descendants 保证。
- `diagnostic-cell-independent-loaded-identity.json` 记录 PID `990`：`SecCodeCopyGuest` 严格固定 leaf DR 有效，identifier `io.github.zclaudia.zody.cua-helper.node`，CDHash `3c57a9bb…`，flags `65536`，空 entitlements `0`，observed `2026-10-31T04:21:43Z`；该直接 OS 身份证据与 native audit 自报日志分开。
- `diagnostic-attempt1-native-events.log` 记录：12:21:33.717 cell `990` suspended；12:21:33.730 loaded verified；随后 resume；12:21:34.012 source 3,575,522 bytes；12:21:34.499 confirmation presented；12:23:32.928 timeout `authority-eof`、allowed false；cell `990` SIGKILL/reaped；capture-rejected `connection-failed`。没有 actual OS completion，也没有 UI Stop。

## 在途 Stop 与完成审计

- **PENDING，不记通过**：native audit 实现已完成并由 controller 复核 strict schema；2 文件 150 项独立测试、typecheck/lint/architecture 在 audit 后均通过。新 diagnostic-audit build/checks 已完成，但 actual OS completion + UI Stop 仍未执行。
- Diagnostic attempt #1 是 native confirmation timeout，不是 Stop：用户未在 120s 内点击，随后 `authority-eof` / allowed false、cell SIGKILL/reaped、capture-rejected `connection-failed`。不得把该 timeout 记为 screenshot 或 Stop 通过。
- controller 仍在等待用户回答当前 prompt/native click 可见性；目前没有回复，在回答前不应再尝试。下一次尝试仍需要用户实际 native confirmation click。
- 已批准的 diagnostic gate 会在真实 submit 后持有 actual OS `CGImage` completion，不是 fake 或 pre-admission gate。验收只接受真实 `hasImage` completion-held + submit-return-before-UIStop；不把该诊断 gate 当作 native Fenced 或 OS 内部取消屏障，也不得用 fake/pre-admission gate 替代在途 Stop。
- 后续只接受真实 OS completion 未消费/未交付时的 UI Stop：authority 先撤销，native cancel/drop 迟到图片；只有实际 `callbackReleased` 与 lease release 后才能报告释放，unknown 保留 lease。不得用旧 Stop、不同 lineage 或 post-delivery cancel 替代。

## 包装缺陷分账

- 首次系统启动 PID `49687` 的 SIGTRAP 对应 unified log `electron/shell/app/electron_main_delegate_mac.mm:65 Unable to find helper app`：父 display/name 已改，但四个既有 Chromium Helper bundle/executable 仍为 `ZodyPreview`。已按构建期一致重命名修复；该实际 fatal 不归因于 ASAR header。
- ASAR whole-archive hash 与 raw-header integrity 混用、以及 afterPack 后再改写导致的 stale embedded hash，是分开的 packaging correctness defect；fuse4 `EnableEmbeddedAsarIntegrityValidation` 首次候选实测为 false，未修改 fuse，也未用签名/TCC 绕过。不能声称 header 校验导致上述 SIGTRAP。
- 修复后 formal header verification：raw header SHA-256 与 embedded 值相等（`fffcb73b…`），archive full SHA-256 独立记录为 `82ef111a…`；candidate manifest 也分别记录 header/archive 摘要并标记 `embeddedIntegrityUpdated: true`。

## 源冻结、清理与操作修复

- opening 校验 4269 个源文件未变，源清单 SHA-256 `27ec8b1a846f2730e01cc9ed13bf137a47dd67a1edf4d55c21e62d7844f6b7df`。`changed-vs-prior-freeze-after-native-audit.json` 当前列出 12 个变更：10 个 packaging/spec + 2 个 native audit source/test；不得把这 12 个文件统称为 packaging/audit。本轮最终冻结为 `frozen-product-final/`：4275 个文件，18 个修改/新增（12 个原有文件修改、6 个新文件）；全部当前文件与冻结清单再次核对，0 mismatch。源文件清单 SHA-256 为 `98a35c35cbd050e7c7d778720777d5a017965b6eabc153d0f78e8400b0868c4d`，这是 source manifest 摘要，不是 Rust frozen-tree 摘要。源码与相对前轮差分归档 `source-and-patch-product-final.tar.gz`，SHA-256 `fae6b3a2ddebf93a8a59ab71dc85c7211ac45845866079c86ac2c3e0c4a67a01`。
- controller 清理记录：sibling scripts/experiments cleanup README，目录减少 14.2GiB，63785 protected，0 mismatch；不等于所有物理空间已释放。
- 旧 output 报告曾被误写，已用最近 patch 的 exact inverse 恢复；恢复后 SHA-256 与 worker 记录一致（`c0a77c80…`）。透明记录见 `operational-repair-audit.json`；未改生产源码、测试或旧验收结论。

## 保留 OPEN / PENDING

- 产品临时收口；在途 Stop 与 diagnostic completion-held 证据 PENDING；attempt #1 timeout 不是 Stop。
- native audit strict schema 已 complete 并由 controller 复核，150 项独立测试通过；audit 日志仍是 operational self-report，不能替代直接 SecCode 身份或授权证明。
- accepted ordinary Host 可伪造来源的缺口 OPEN；`hostInstanceId`/`runtimeInstanceId` 仅路由，`inputOrigin` 不能抵御恶意 Host。
- 默认禁用与 `zcodeCuaPlaceholder: true` 保持不变。
- 完整 D06/OS 隔离、native input Fenced、all-descendants 退出、6 项 JS license missing、Intel/最低 macOS 实机、升级后 TCC、完整 CLI 兼容与 live task provider 配置兼容仍 OPEN。
- 本轮源码已冻结并归档；完整产品验收仍未通过。JS 许可材料归档不等于法律采用通过，6 项 missing 保留。

## 证据索引

- 本报告目录 `evidence/` 保存源码/差分压缩包、构建/实测证据压缩包及 SHA-256 索引；不包含凭据或传输认证 key。
- Opening / 冻结：`opening.json`、`opening-source-pins.json`、`changed-vs-prior-freeze.json`、`metadata-pins.json`
- 静态检查 / audit：`independent-checks/typecheck-after-native-audit.log`、`lint-after-native-audit.log`、`architecture-after-native-audit.log`、`native-audit-independent-tests.json`、`native-audit-independent-tests.log`
- Native probes：`independent-checks/target-identification-compile.json`、`loaded-process-identification-compile.json`
- 包装测试：`independent-checks/packaging-final-tests.json`、`packaging-final-tests.log`
- 正式打包：`independent-checks/formal-pack-production-fixed.json`、`formal-pack-diagnostic.json`、`normal-host-diagnostic-audit-build.json`、`controller-normal-host-diagnostic-audit/normal-host-candidate-manifest.json`
- 首次 fatal：`independent-checks/first-system-launch-unified-log.json`、`first-system-launch-unified-log.log`
- 产品启动/截图：`production-observation.json`、`production-startup-selection.log`、`startup-snapshot-production.json`、`production-tool-image-facts.json`、`production-tool-image.png`、`production-tcc-subject.log`、`production-tool-usage-readonly.json`、`production-cli-turn-tool-events.jsonl`、`production-lease-independent-after.json`、`production-quit-observation.json`
- 诊断审计 #1：`test-target-before-diagnostic.json`、`diagnostic-native-events-before-stop.log`、`diagnostic-attempt1-native-events.log`、`diagnostic-cell-independent-loaded-identity.json`、`changed-vs-prior-freeze-after-native-audit.json`、`native-audit-worker-completion.json`
- 身份/ASAR：`candidate-trusted-signatures.json`、`controller-normal-host-production/normal-host-candidate-manifest.json`、`controller-normal-host-diagnostic/normal-host-candidate-manifest.json`、`known-packaging-defect.json`、`formal-header-integrity-verification.json`
- 操作修复：`operational-repair-audit.json`、`host-worker/host-worker-report.md`

## Controller 最终归档核对

- 4275 个冻结源码成员与当前文件及源码压缩包逐项 SHA-256 核对，0 mismatch；18 个增量文件（12 修改、6 新增）未覆盖其他本地改动。
- 构建/实测压缩包的 126 个成员逐项核对，0 mismatch；SHA-256 `d111bb71673dd17489c20c805bd6895dad8fc9c2bc3e4e1a19029c6a25c2ee35`。完整索引见 [evidence/SHA256SUMS.json](evidence/SHA256SUMS.json)，可直接审查 [增量差分](evidence/incremental.patch)。
- 普通 Host 截图与 cell 正例有实测；在途 Stop 未获得原生点击，保持 PENDING。现有候选留在空闲状态，没有在途截图或持有机器锁的验收调用；再次实测前必须重新识别进程和窗口，不能复用本报告 PID/window ID。
