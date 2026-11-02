# 真实桌面会话接线验收（2026-10-30）

**本轮真实桌面“截图→原会话图片→UI Stop”验收通过（19:23—19:24）。** DeepSeek修复原生连接交接的O_NONBLOCK模式不匹配，controller独立审查、完整构建签名并实测。真实Helper返回2400×1600 PNG，资源及machine lease释放；原会话收到并能打开图片，随后UI Stop撤销同一lineage、取消正在执行的等待工具。功能仍默认禁用，`zcodeCuaPlaceholder:true`；本轮没有安装证书、改TCC或放宽library validation。

通过仅限独立显式候选的单窗口链路，不代表完整Phase 1或产品采用验收。此前TCC日志的responsible/subject为Codex，Helper独立TCC归属仍未证明；native Fenced/输入屏障、完整D06、Intel/最低系统与升级稳定性保持原有边界。

最终制品：`output/cua-desktop-session/controller-{build,signed,ui}-authority-fd`。可复核结果：[结构化验收](evidence/authority-fd/ACCEPTANCE.json)、[真实工具图片](evidence/authority-fd/actual-tool-authority-fd.jpg)、[事件记录](evidence/authority-fd/authority-fd-success-events.json)。

## 完成的实现

- 按用户批准的方案，Electron作为非受信UI；既有window-scoped Host/CLI运行于固定签名Node与封装代码。保留原身份、CommandInbox、唯一CuaSubmissionAuthority、turn scope、machine lease及frame owner，没有新增授权状态。
- Main→Host fd5桥与Host→CLI fd6/7链路实际启动成功；真实Host/Session数据库迁移、服务ready与Dispose通过。存储worker作为固定源码快照封装，没有跳过准备流程。
- 实际桌面模型回合发现并调用本地node_repl工具；只有native capture和本地工厂同时显式装配才注册。普通启动、缺依赖、显式MCP disabled不自动注册，也不修改插件/用户设置。
- Helper复用固定签名、真实Node peer与代码验证；原生确认绑定本次submission/目标，确认后及交付前复核原owner。截图按已验证原始PNG转模型图，正常关闭不错误撤销lineage，用户stop仍走原有撤销/abort。
- 修复确认窗口ARC与AppKit重复释放；本地工具descriptor保留已有有界server timeout，内部cell timeout与stop仍取消。交付事实只在native ACK和最终绑定检查后记入既有app logger，不记录像素/用户正文/凭据，日志不是授权或Fenced。
- UI候选补齐scheduler资源、ESM兼容入口；禁用该独立候选的远控连接以避免现有安装版gateway冲突，不写回用户远控设置。

## 真实实测分账

| 层级 | 实际结果 |
| --- | --- |
| 原Electron严格LV方案 | 自签名main/dylib及实际Electron/Framework均strict验签通过，但真实加载SIGABRT；用户批准改为可信Node方案。 |
| 当前原生构建/签名 | 完整编译、链接通过；既有证书签名的Helper及固定Node strict verify通过；arm64、SDK27、minos14.2、系统`/usr/lib/swift`，没有DYLD覆盖/复制系统库。 |
| 可信Host/真实桌面 | 临时HOME完整InitLocal→DB迁移→services ready→Dispose exit0通过；独立Electron UI→真实Host→CLI→实际模型回合通过。 |
| 工具发现/实际调用 | 最终回合serverCount1、registeredToolCount1，实际调用`mcp__node_repl__js`，不是手写fixture工具记录。 |
| 原生确认/截图 | 修复后通过原生确认及全部checkpoint，实际PNG 2400×1600/476125bytes；controller从未代点native同意。前次失败与超时分别保留。 |
| 截图/停止候选验收 | **通过本轮单窗口流程**：同会话tool image已目视验收；Stop记录user-stop/revision2，后续等待工具取消。不报告native Fenced或输入屏障完成。 |

前次capture-delivery真实session：`sess_9e87a356-41ec-473b-a482-ae6bfbbbcad8`；目标Zody Dev PID14879/window87802；Helper PID15368/Node15399。`real-desktop-acceptance.json`保存有界事件投影及最终超时事实。其后重试的generation2明确记录user-approved，2444ms后capture-failed/eof，owner以control-lost撤销；详情见`evidence/final-candidate/retry-eof.json`与`retry-native-stderr.json`。

## 必要检查

- 根`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`通过；最终lint **301 warnings / 0 errors**，architecture0violations。各阶段日志保留，不覆盖失败。
- 独立Desktop Main typecheck：开工preimage overlay baseline86/current86/added0；使用当前依赖类型，不声称独立Main全绿或完整旧树重建。
- Host/storage/service七套件104 tests通过。CLI前次五套件35 tests通过；最终受影响三套件22 tests通过（包含重叠，不相加）；另CLI launch4、真实owner撤销2、candidate remote3通过。
- 构建工具11 tests通过，无skip；最终完整native构建中四个纯测试程序通过。固定签名Node `--jitless` 的真实本机HTTP流式/重定向/取消检查通过。
- 旧native冻结材料2079文件摘要未变；最终构建3743个唯一JS输入与当前文件摘要一致。该数字是构建输入集合，不等于运行时包数或Rust目标图。

## 保留的实测失败及修复

1. 早期缺jitless、undici依赖Wasm、sealed data URL/createRequire、存储worker不退出：分别修正固定Node参数、候选纯JS HTTP适配、固定module URL及真实storagePrepared后worker退出；未通过timeout伪造ready。
2. 实际工具目录为空：补显式候选注册；第二次实跑仍为空，controller核对实际model-io与metafile发现旧bootstrap/dist被封装。构建现按公开包exports解析当前源码并拒绝工作区dist残留；六入口均0残留，第三方锁定来源未改。
3. 原生Helper PID97169 SIGSEGV：主线程objc_release/NSArrayM/autorelease；supervisor已越过allowed decision进入window_still_matches。controller没观察或点击native同意，不推定是谁点击。修正ARC父窗口`releasedWhenClosed=NO`后，真实等待取消不再崩溃。
4. 修正版外层30秒超时覆盖了js显式120秒：descriptor现保留已声明的有界server timeout。最终实际运行到120秒内部超时，未把超时取消当成截图或用户stop。

## 来源、依赖与许可边界

前次冻结制品在`output/cua-desktop-session/controller-{build,signed,ui}-capture-delivery`；构建命令和签名步骤见`rebuild-capture-delivery.json`。Node/视觉库/原生来源继续使用冻结配置；本轮正常截图不自动revoke的派生patch与原始/结果SHA均在`macos-cua-desktop-session/source-baseline.json`，旧源码只读。

六个JS入口的构建审计、实际输入摘要与许可证材料保存于冻结目录。按name/version去重169项第三方材料条目；CLI入口176个物理包条目、Host18、node-repl12，存在重复，不能直接相加。缺许可正文仍有6个name/version：provider-utils4.0.27与4.0.39、data-uri-to-buffer4.0.1、omggif1.0.10、parse-bmfont-ascii1.0.6、quickjs-wasi2.2.0。R8视觉根0missing不覆盖新Host/CLI闭包；未做法律审查或产品采用批准。

候选裁去terminal/SSH等原生能力，不是完整Host功能等价替换。Cell脚本hash校验后按路径启动仍有TOCTOU限制，不声明完整D06。Intel、最低macOS实跑、完整输入/Fenced/升级稳定性仍未验收；本轮没有新增这些矩阵。

## 归档与下一步

来源快照、相对开工preimages的patch、3743个实际bundle输入压缩包、图、许可及构建上下文均归档在[冻结目录](./frozen-candidate/sha256.json)，本地重建副本为`output/cua-desktop-session/frozen-capture-delivery`。冻结清单SHA-256：`30041a66aa61c45de47f14c692923a0d1214bb2e0851153a1a8d2361694b89b8`。当前报告的`source-and-evidence-sha256.json`记录文档与必要证据摘要。UI原始runtime日志包含既有产品设置，保持本地0600，不复制进验收归档；只归档本测试的必要白名单投影。

该冻结版本的截图/停止当时未通过；后续修复及本轮通过记录见下节，旧失败证据不覆盖。

DeepSeek路线为`deepseek-flash / magpie / group/deepseek`（本轮routes实际值）；三名writer与文件所有权见[实施计划](../../../../../../docs/plans/computer-use-macos-phase1-desktop-session.md)。controller独立审查并实跑所有上列证据，无Git提交。

## 18:13—18:25实测历史（已由下述修复解阻）

- 用户确实点中了前次新请求：generation2 `allowed:true/user-approved`。随后采集失败，Helper主动关闭该authority连接；`cua_native_capture_closed:eof`、owner `control-lost`是后果。Helper/Node当时仍存活，无截图交付。controller后来SIGTERM该失败Helper仅为让既有stderrTail落盘，不能记作用户Stop验收。
- 原生错误映射此前把TCC/visual/context等统一为capture-failed，证据不足以定位根因。DeepSeek仅修复有限枚举的诊断映射；不改变任何授权、lease、capture或资源归还判断。未知/动态错误仍泛化，不输出任意底层文本。
- 新候选`controller-{build,signed,ui}-capture-reason`完成完整原生编译/链接、四个纯测试程序和既有证书strict验签。六入口的实际JS输入集合与capture-delivery逐项完全相同，许可/依赖边界不变。原冻结目录保持只读；新native源码及相对冻结版patch、构建/签名和输入对比在`evidence/capture-reason/`。
- 根typecheck、architecture通过。归档源码副本曾造成root lint 3个max-lines错误（原路径override不适用于归档位置）；精确排除本报告的冻结源码副本后，controller重跑`pnpm lint`通过，301 warnings/0 errors，未放宽生产源码规则。失败日志与通过日志均保留。
- 新候选实际session `sess_f53d017c-1e1f-456c-8446-954e64ff2d31`，目标PID72383/window87954，Helper72924；18:23新请求等待native确认，120秒内部超时。没有新截图、没有截图后UI Stop，不能使用晚到回复复活这一generation。
- 系统TCC记录在前次请求中将responsible/subject归于`com.openai.codex`，requesting为Helper。该事实不能证明最终Helper独立拥有TCC；本次没有申请/修改权限，也不把此差异猜作采集失败根因。

这时阻断是批准后的采集失败，具体子阶段尚未知；19:17取得精确失败并完成如下修复。

## 最终修复与真实验收

19:17同一诊断候选再次获得用户确认，固定错误为`visual-start-denied`。源码与真实socketpair复现共同确认：accept函数强制O_NONBLOCK，随后冻结R11 AuthorityClient却以阻塞recv逻辑读取，EAGAIN触发关闭及首次checkpoint拒绝。原生交接方现显式清除O_NONBLOCK、保留其他file-status及descriptor flags，失败即拒绝；旧R11/视觉源码不修改。controller还要求修正测试中等待on_closed回调的竞态；最终真实延迟response及interrupt回归均通过。

controller独立完整重建的五个native测试程序全部通过，编译链接/固定自签名strict verify通过；根typecheck、lint、architecture通过，lint301warnings/0errors。六入口JS实际inputs逐项与前次冻结候选相同，未重做或扩大许可结论。新源码差异tar/patch/摘要、原生build manifest、签名制品摘要及检查日志在`evidence/authority-fd/`；原冻结目录1309份材料保持原样。

真实会话` sess_490310af-5c4f-4391-8fd6-360a131080b4 `，turn `turn_f83cb32d-b27d-45d4-83eb-a856d7d36a5c`；UI PID13515/window88108，Helper14065。11:23:41.694Z原native ACK及最终scope检查后记录交付，PNG SHA-256为`427d7fcec5a16e483fa75b3f12b14fdf2ff18ef491ae895783d9b4d8cd48e072`，resourcesReleased与machineLeaseReleased均true。模型图为2048×1365 JPEG、149977bytes/base64 199972chars，低于200KiB base64预算。model-io仅保留image/jpeg结构而隐藏数据；controller从真实UI的Result image 1下载原工具图并独立目视核对指定窗口，没有用controller截图冒充Helper输出。

截图成功后第二个js工具进入90秒等待。controller在11:24:11.429Z点击真实界面Stop，同一lineage `7175ccc6-c4c0-4b1a-b535-22d34143b5bd`记录`user-stop/revoked/revision2`；11:24:11.437Z该等待工具以TOOL_CANCELLED结束，UI显示Stopped。资源/lease是在此前截图完成时释放，不能把该事实改写成Stop期间native drain或Fenced。之后未再启动截图调用。

本轮要求的链路已完成；继续保持默认禁用。后续产品激活前仍需解决已列出的独立Helper TCC归属等既有阻断，本轮不扩验收矩阵、不替换签名方案。
