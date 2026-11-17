# macOS R2 实施与受控验收

状态：**R2收敛范围验收完成**。用户已确认AppKit及最后Electron通过轮未观察到输入、焦点、鼠标或窗口异常；控制输入用例已通过事务审计晋升，历史失败不追认。R3和最终发布未启动。用户已于2026-11-15明确授权限定写实现及受控验收；以当前未提交R1工作区为基线，无reset/clean、旧workflow恢复或自动提交。

## 当前执行清单（用户要求收敛后生效）

本节是唯一执行状态表；下文保留历史事实，不从历史“尚待”措辞追加任务。产品安全边界不变，执行分层见 [spec 的 R2 收敛测试计划](../../specs/computer-use-macos-phase2-ax-driver.md)。每组合 20 次归回 R3 发布验收；本期不启动 R3。

| 项目 | 当前状态 | 后续只做这些 |
| --- | --- | --- |
| native/CLI 安全合同 | 已有通过证据：25 组 native、247 项 node-repl 及相关合同/收据测试；最近仅 busy 早拒绝收据改变，57 份 native 源摘要未变 | 复用未受影响结果；新增产品修复才运行对应回归，不把每个边界再扩成真机案 |
| Stop、R1 读取、忽略效果校准 | Stop 2/2、R1 4/4、实际忽略效果被检出；分别保留原候选身份 | 直接复用，不因 busy 收据或测试脚本变化整轮重跑 |
| 自动真机：租约 | **通过**：v4 中途读取/失败后65.74秒busy，130.01秒acquired；重新确认后第二笔sent，目标+2、兄弟不变 | 此项结束并复用，不因后续截图环境设置重跑 |
| 自动真机：截图借锁 | **通过**：v6实际PNG 620×404/31277字节，原生SHA/尺寸/字节一致；借用归还且控制锁未释放，新冻结状态再次写成功，目标+2/兄弟不变 | 此项结束并复用；租约未重跑，产品和签名未变 |
| 人工输入：AppKit | **9/9通过**，3/3 tests exit0；主控与独立Terra逐字段核验；用户人审通过 | 结果复用，不重跑 |
| 人工输入：Electron | **新轮9/9通过**，3/3 tests exit0，主控与Terra逐字段核验；此前1笔输入取证失败保留 | 两平台18笔合格/19次真实写尝试；不追加输入测试 |
| 收尾 | 技术检查、独立核对及用户人审完成，控制输入用例已晋升 | 本期结束；不追加真机轮次，不启动R3或发布 |

执行前只需收敛现有驱动的数量和 return_state 映射，并离线自检，复用已有 helper/fixture；不新建测试框架或增加监测字段。人工准备在构建、自动项及驱动自检完成后统一提示，等待在 SDK 外。已经发生的纯键入就绪记录没有与写事务交错，不能补算为通过。

两项自动案共用原单槽签名候选，无产品重建。自动前已在候选封装的真实 node_repl cell 中验证导入/计时API，OS调用为0；E2E类型与两份fixture检查通过，保留标记warning。租约v1的模板错误、v2旧夹具离屏（零写）、v3 runner外层120秒截断均保留；v4使用现有 `ZODY_E2E_MANUAL_REVIEW_HOLD_MS=120000` 使外层预算为240秒，产品租约仍为120秒。只有v4证明了完整到期路径。第二cell聚合isError来自刻意验证的不支持key拒绝；两笔真实写收据均为sent，不把拒绝当成功。

本轮核验摘要为 `output/cua-r2-20261115/automatic-acceptance-review.json`。v1系统日志明确屏幕录制主体为外层 `io.github.zclaudia.zody.cua-launchservices-candidate`，对旧代码要求匹配失败；用户重新开启后，v2日志明确 `kTCCServiceAccessibility` 的主体为内嵌 `io.github.zclaudia.zody.cua-helper`，当前Unknown后被系统设为Denied。两份候选签名/资源均未变化，不能推断两次系统状态变化的原因，不能以用户设置动作代替实际采集通过。v2未到截图核验，无PNG、无写派发；该辅助功能环境设置已单独明确提示，人工输入尚未启动。

用户开启Helper辅助功能后，v3真实读取和首笔控制恢复；截图再次被 `tcc-not-authorized` 拒绝。系统日志仍明确外层ScreenCapture旧代码要求不匹配，当前候选deep/strict签名校验正常，两者当前designated requirement均为固定identifier和同一证书leaf。未修改签名或绕过TCC；先前仅关闭/开启的设置提示不足，现明确要求移除旧屏幕录制条目后按当前外层App路径重新添加。v1/v2/v3均保留失败，不重复租约和其他通过项。

用户移除重添后v4仍拒绝，停止重复界面设置和试跑，改为只读定位。独立Terra与主控核对确认：TCC仍保存旧 `cdhash bec66b589350978f0252d4baf0c96d74d085e24f`，实际当前候选CDHash为 `a34d616bca960e47cd1b1a0e8334d8ee158d368e`；当前证书型designated requirement和deep/strict通过并不会满足数据库中的旧cdhash要求。LaunchServices另留有5份已删除的同identifier候选记录。主控仅注销这5份失效路径并刷新当前App注册，再通过官方 `tccutil reset ScreenCapture io.github.zclaudia.zody.cua-launchservices-candidate` 成功清除单个候选的失效录屏记录；没有编辑TCC数据库、没有更改签名、没有操作其他应用权限。复核注册只剩当前run-slot，等待用户重开系统设置后重新授权；清理本身不等于授权或截图通过。回执为 `targeted-tcc-registration-repair.json` 与 `candidate-registration-after-repair.json`。

v5复验确认定向清理已生效：日志不再报告旧代码要求不匹配；但ScreenCapture仍返回Unknown(None)。同时可见外层App的 `kTCCServiceAccessibility` Allowed更新，该事实不能代替ScreenCapture授权。未再重置权限或重建候选，使用系统链接 `Privacy_ScreenCapture` 帮助定位正确设置页，等待录屏服务授权；无PNG和借锁正例，失败原样保留。

用户在录屏页面完成设置后，系统日志于2026-11-15 21:28:26明确记录当前外层候选的 `kTCCServiceScreenCapture` 为Allowed；先核对该记录再执行唯一待验截图案。`e2e-capture-v6` **1/1通过**：同一turn的读取、首笔控制、独立截图确认、真实provider PNG交付、新冻结state再次控制完整；PNG为620×404、31277字节，SHA-256为 `fb4241f0a7d6f11e283405dda33c9cdbedd79d1679cb9af1c707397fdc630be8`，与原生审计完全一致。收据 `machineLeaseReleased:false,machineLeaseBorrowReturned:true,resourcesReleased:true`，两笔写同scope不同attempt且均sent，目标业务模型+2、兄弟不变。主控独立逐字段核验通过，摘要 `automatic-acceptance-review.json` 已记录两项自动案通过；旧失败仍保留，未重跑租约、Stop、R1或校准，未重建或改签候选。

18笔驱动准备完成：移除本轮deny重跑，三种动作各按none/compact/full固定3笔；逐笔验证return_state、state_sync_status、真实状态身份及业务效果。新增离线回归先红（61调用/错误模式）后绿2/2；同一签名候选Node cell执行9个模拟SDK模板、实际回放server完成12请求接链均通过，OS调用0，不计真机成功。两平台分别使用新fixture/monitor目录，700ms真实业务屏障不变，监测begin ACK在允许控制前须证明active/key/firstResponder。独立Terra只读复核无阻断。根typecheck、E2E类型、fixture、架构0 violation、lint 320 warnings/0 errors通过，标记warning保留。

人工结果：AppKit `manual18/appkit/evidence` 九笔及Electron `manual18/electron/verified-input-v3/evidence` 九笔均真实完成（各3/3 tests、exit0）；主控与独立Terra逐字段复核：每笔前台/编辑焦点保持、真实硬件键与插入文本一致、fence后新键→700ms屏障release→业务效果，原生admitted/completed与sent收据一致，三方法各none/compact/full、目标每笔requests+1且兄弟/窗口不变。两平台合计18条规定路径齐全，未重复AppKit或既有自动案。

Electron历史失败原样保留：首次SDK外等待15分钟超时，provider/SDK/写均0；恢复后第一笔left_click/none实际sent且目标presses+1、兄弟不变，但4个硬件“1”对应 `insertedText=11\n\n`，该笔失败、不计合格。旧监测按初始长度截末尾，离线可在中间插入复现同类错误；历史未记录选区，不能追认该笔为误报或通过。修正为真实初始文档/选区与结束文档推导插入，验证未编辑prefix/suffix，无法解释则null，保持原评分器与JSON字段。纯Foundation回归先红exit134、后绿（10断言），独立Terra确认未放松丢字判据；只在新目录重建监测夹具，产品候选不变。以新fixture/monitor和新attempt执行尚未合格路径，不重放旧已发送attempt。新轮9/9通过；因此准确总数为18合格、19次真实写尝试、1次输入取证失败，另有0调用就绪超时。

最后监测修正后的根typecheck、lint（320 warnings/0 errors）、架构0 violation通过；晋升后已补跑正式路径E2E类型、fixture及根检查并通过。新旧监测摘要、先红/后绿、主控与Terra核验、真实失败均保存在 `manual18/`；技术快照 `manual18/final-technical-review.json` 采集时尚未人审，故其humanReviewComplete=false保持原样，最终用户确认另见文末收尾回执。

准备失败另记而不消耗人工试次：离线cell缺少常规plugin root注入，显式使用模拟SDK路径后通过；直接启动夹具缺少LaunchServices启动时间，零写下停止精确进程，改经LaunchServices启动后两平台身份/四窗口可见通过。现有AppKit测试夹具缺资源封套，仅为夹具补ad-hoc签名，未改产品候选；候选deep/strict与12份Helper摘要一致。证据位于 `output/cua-r2-20261115/manual18/` 及同级 `manual18-*.json/log`，未重复租约、截图、Stop、R1或校准。

退出条件：两项自动真机案通过、18 笔规定路径均有真实业务效果/兄弟不变/收据/硬件输入与无干扰证据、相关确定性回归和规定检查通过，完成一次独立证据核对后结束 R2 技术验收。任一必要项失败或未知就保持未完成；仅修复并复验受影响项，不通过追加试次或新维度追求“更放心”。所有失败保留，可能已发送的动作不重放。

不再执行：完整系统故障排列、重复 R1 锁屏/睡眠/输入监测校准、每种不支持参数的真机排列、整轮功能性 20 次重复、R3 build/sign/freeze/pin 发布审计。测试脚本/报告变化不重建产品；封装产品字节变化时才一次重建、签名及闭包核验。此表为计划调整，本次没有启动任何新桌面测试，也没有将未验证项改记通过。

## 基线核验

- 归档 `20261115-152646` 的 README、清理回执和 evidence manifest 已读取；指定五份最终验收 JSON 均逐项验证 SHA-256 与大小，没有整体还原归档。
- R1 单用户正常桌面收尾及四项晋升保留。默认 03a 只证明有限本地投影，系统远端正文/索引/句柄不开放；AppKit 20/20、Electron 20/23 的三个未证明试次及历史失败保留。跨用户和长时间休眠未验证。
- freshness 通过；开工架构 0 violation。Node 24.14.0、pnpm 10.33.2。当前 shell 无 mise，使用已经安装且与 mise.toml 相符的精确 Node 路径固定子进程 PATH。
- 文档的 `pnpm clean:output -- --apply` 被当前脚本拒绝（多余 `--`），改为其实际接受的 `pnpm clean:output --apply`，确认 output 当时不存在。

## 实现及执行历史（不追加完成门槛）

Helper 控制 owner 持有既有 MachineLease、完整可信关联、精确窗口/启动身份与 120 秒空闲租约。原生 gate 排序 Stop 与最终派发；阻塞 AX 期间有独占 reader 监测，首次写 ACK 后保留同 authority 的失效 watcher。独立 consumer 共享唯一 owner 撤销，单次关闭不误伤监听。

仅支持冻结元素 AXPress（left_click / perform_action）及可设普通字符串 AXValue（set_value）；最终准入前重核原句柄实际 PID/窗口，迁至同 PID 兄弟窗口仍零派发。控制与读取确认独立，set_value 的旧值类型判定先读取确认；none 无写后观察。compact/full 的必要读取先于控制确认，写后失败保留收据，不重放。

截图借用同完整 scope 的控制锁但不续租，真实释放与归还借用分别记账；identity/remote 关联贯穿 checkpoint。组合截图通过内部 commit_state 原样提升已交付冻结映射。SDK raw 返回保留已授权状态，动作 not-ready 不自动重试。

规格及事件图见 [R2 启动合同](../../specs/computer-use-macos-phase2-ax-driver.md)。

## 独立审阅与回归

原生和 CLI 调查分别由两位 Terra 只读完成，再按 disjoint 目录实施；独立 Terra 只读审阅发现的确认顺序、可选 app_ref、空 modifiers、busy 收据、截图冻结、派发一致性及截图关联缺口已补回归修复。主控另发现最终元素迁窗、SDK 状态解包/动作退避及生产审计投影缺口，均先复现再修复。

- 原完整 Helper 24 组 native 测试通过；其后仅日志格式与最终元素重验有原生变化，主控分别独立重编并执行对应回归通过，最终候选重新完整编译/封装，未热补封存字节。
- 真实双进程 MachineLease 竞争已记录 busy；确定性测试覆盖 Stop 前后、迟到、到期、只成功续租及旧身份。不能用这些代替真实 SDK/桌面验收。
- authority 68 项在正式声明测试 devDependency 后正常环境通过；临时链接诊断及原缺依赖失败保留。
- 审计解析最终 180 项通过；SDK 实际客户端回归 8 项通过；UI/收据/相关 R1 focused 最终 212 项通过。
- 根类型、CLI 类型、E2E 类型及架构已有通过记录，仍须在最终修改结束后核对最终退出码。Lint 保留实际 warning，不声称零 warning。fixture 检查通过并保留固定值 marker 的一项 warning。

## 构建与受控运行

仅恢复必要材料：固定 Rust 1.97.1 的 rustc/cargo 摘要匹配，R9 776 文件/树摘要逐项匹配；Node 用原身份重新签名且 CDHash 匹配 pin。视觉库由固定源和工具链重建；Helper 严格 deep 签名及 prepare 闭包通过。桌面候选复用 `output/cua-r2-20261115/run-slot`，内嵌 Helper 12 文件与准备件逐字相等，不修改冻结发布 pin。

首次外层 Electron framework 签名验证失败，补齐该候选自身 framework 签名后严格验证通过；首次比较 Helper 时用错目标目录，修正为 builder manifest 的实际 destination 后 12 文件一致。均为构建核验问题，未将其算作产品通过。

已晋升用例：`packages/desktop/test/e2e/conversation-session/conversation-session-cua-r2-control.test.ts`。固定provider只合成模型调用，真实权限、工具结果、native派发及业务模型均不合成。正式目录仍仅显式定向执行，默认全量排除CUA R2，不进入Docker默认套件。

第一轮 AppKit 失败/控制器取消：真实 WebDriver 点击可在 focus 后同次提交，验收器仍等待已关闭旧卡，拖慢一个 cell 的 20 次批量动作并触发默认 SDK cell 时限。取消时最终目标模型 presses/requests=30，兄弟均为 0；该轮没有完整收据，不计通过，不把业务变化追认为验收。已修卡片消失判断，改为每个 SDK cell 仅一次动作，逐次持久化实际收据，第二轮使用同一运行槽进行。

### 后续功能轮与最终守卫复审

- v2 的双击旧卡问题、v3 对预期拒绝 aggregate isError 的误判、v4 的后续 replay matcher 问题均属于验证器失败，不追认。v4 由控制器取消，不记为用户 Stop。
- v5–v9 在写前读取阶段被原生 `ax_unique/cg_unique` 精确窗口守卫拒绝；v6 起保留真实工具错误，v7/v8 明确为 `element_unavailable/not_sent`。CG 窗口存在且 onscreen；这些事实不足解释 AX 唯一映射为何未成立。更换受控夹具、启动时前台准备未单独解决；随后独立只读 AX 观察与新轮读取恢复。根因未确认，失败保留，不放宽守卫或追认为通过。
- v10 完成真实目标控制拒绝和 11 笔点击收据后，验证器误将新到控制卡识别成普通 node 权限卡而退出。修正为同一 DOM 快照排除全部 CUA 卡，防止并发换卡误分类。
- AppKit **v11 4/4** 和 Electron **v1 4/4** 完整功能轮通过：各有一次实际 control 默认拒绝点击及零派发/零模型变化；left_click、perform_action、set_value 各 20 次 sent 收据与真实业务模型效果一致，同 PID 同标题兄弟窗口不变。每种操作包含 compact/full 实际状态返回，其余 none。原始收据与前后快照在各 `r2-functional-receipts.json`；该轮没有物理输入监测，不声明无干扰通过。
- 最后独立 Terra 审查发现首次元素复验失败未清映射，可能恢复后复用旧索引；阻塞支持性 getter 后也缺少最终资格采样。补先红回归（exit134）后，首次/最终失败统一停止租约和清映射；getter 后重核原句柄 PID/实际 PID/直接窗口，最终 admission 前再次用无 AX RPC 的系统/进程启动/hidden/精确 CG onscreen 事实检查。定向 native 回归通过，正在完整重编新候选。旧功能轮对应候选摘要存于 `functional-candidate-before-final-guards.json`，不能冒充新候选结果。
- 真实输入验收使用独立受控业务屏障及前台 monitor 主线程 fence。纯 scorer 9/9，强制 pending→fence 请求/ACK→新硬件 key→release→业务快照因果链，核对原生 audit/receipt、独立窗口元数据及所有无干扰信号。未实际执行前不能称通过；缺证据或超时均失败/未证明，不重放。

### 最终候选已完成的自动真机项

最终守卫修复后完整 Helper **25 组 native 测试通过**；重新签名、prepare 与单槽候选重建，严格 deep 签名通过，57 份原生源码摘要、内嵌 Helper 12 份文件均逐项匹配。初次重建用错默认视觉目录与 Helper 子目录导致构建/签名命令拒绝，正确读取 manifest 的 `helper/...` 后重做；失败日志保留，未运行错误候选。

- `e2e-stop-v1` **2/2**：真实可达 WebDriver UI Stop 在待控制卡上执行，真实 owner-revoked 事件、native rejected/not_sent、零目标/兄弟变化、工具 stopped 与无 provider 续跑；同会话新 turn 重新独立确认后实际 +1。SDK Stop 在真实目标业务屏障 pending 后执行，真实原始 receipt 为 possibly_sent；随后释放迟到业务效果，native completed/sent 与目标 +1 仍据实保留。旧索引再写 not_sent，重复 Stop inactive，兄弟不变，不重放。
- `r1-03a-regression-v1` **4/4**：当前入口未按 `--mochaOpts.grep` 缩到单项，实际执行 metadata/deny/allow/五步 state 四项（不是仅一项）；五次状态确认 full/diff/silent/full/diff、有限本地投影/不透明截止与无兄弟正文均通过。未执行默认 profile 下的 lifecycle/sleep/多用户，未修改 R1 历史结论。
- `e2e-ignored-effect-v1` 按预期 **退出1**：20 次真实 AXPress 全部 sent，受控目标确实记录 requests+20、presses+0、兄弟不变，验证器 businessEffect/ok 为 false，未把 AX 成功算业务效果。该失败作为校准检出，不是动作正例；独立复核 `ignored-effect-independent-calibration.json`。
- 最新四组 focused 测试 **231 项通过**（保留 jsdom canvas getContext 提示）；R2/R1 纯评分器 **26 项通过**，Electron 屏障 **2 项通过**。根 typecheck、lint（320 warnings/0 errors）、架构0 violation 有最终守卫通过记录。新 E2E 增补后还会执行最终总核对。
- 首次输入轮只等待人工就绪，未发送 SDK、无真实键入、无动作试次；达到用例等待时限退出，记验收器等待失败，不记产品拒绝或成功。下一轮等待时限已与人工准备分开并放在 SDK 调用之前。

所有证据位于 `output/cua-r2-20261115/`。本记录不把组件测试、AX 返回成功、安全拒绝或局部效果算作完整业务效果与无干扰通过。

## 最终人审与收尾

用户已对AppKit通过轮与最后Electron通过轮确认“未观察到上述异常”，记录为 `output/cua-r2-20261115/closeout/human-review.json`。原始machine记录的humanReviewComplete=false表示当时采集快照，保持不改；最终确认通过此独立人审文件关联其SHA-256，不追认旧失败。

控制输入用例先dry-run、再reviewed/apply，覆盖审计通过且fixture原文保留，正式路径见上文。晋升后只运行类型、fixture、lint、架构和新增默认入口排除回归；新增回归先红后绿，默认全量不会因晋升进入R2真机写入，显式定向仍可。依本次收敛授权，不再执行晋升脚本建议的真机重复回放或Docker准入，既有真实两平台证据保持原运行身份，不冒称正式路径重跑。

两项自动验收、18条输入路径、规定检查、独立核对与用户人审均完成，本期R2无剩余必要工作。总计18笔合格/19次真实写尝试、1次输入取证失败保留，其他历史失败亦原样保留。不追加输入或重复已通过项。当前 `request_access` 保持既有不可用路径，没有伪造TCC或grantOwner状态；跨用户、长时间休眠等R1限制保留。R3、20次发布矩阵、冻结发布及最终发布均未启动，没有自动提交。最终回执为 `output/cua-r2-20261115/closeout/final-r2-acceptance.json`。
