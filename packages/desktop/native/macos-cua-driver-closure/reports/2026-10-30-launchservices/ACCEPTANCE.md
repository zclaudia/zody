# 正式应用启动与 Helper 权限归属：本轮窄链路验收通过

2026-10-30。当前不代表最终产品通过，功能默认禁用。源基线为前轮 desktop-session 已归档的真实截图与 UI Stop；前轮报告及冻结源只读。

## 已确认

只读 LS probe 由系统应用入口启动，相同固定 Helper identifier、现有自签名证书、HR/strict validity、空 entitlements。PID38301/PPID1；`CGPreflightScreenCaptureAccess=true`。OS tccd request38301.2 的 screen capture subject 为 `io.github.zclaudia.zody.cua-helper`，authValue2。没有申请新权限或安装证书。第二次 UI 状态观察自动重启 probe 为 PID38709，同样 preflight=true；两次进程均已关闭。

该 probe 仅证明方向；下文最终完整候选的实际进程、TCC、截图及 Stop 是本轮结论依据。

## 委派与边界

DeepSeek route `deepseek-flash`，provider `magpie`，model `group/deepseek`；普通 workspace-write，无 UI grant。native worker `broker:deepseek-flash-rw-ec6bf2fd7be1a108:01a18b7a-7ae3-7982-9592-bf4fdfb467d5`；Host/app worker `broker:deepseek-flash-rw-ec6bf2fd7be1a108:01a18b79-ddd4-7ac1-8175-fea629f41b57`。文件互斥，controller 独立审查及测试。

本轮只解决正式 .app 启动、Helper TCC 归属与既有截图/Stop 接线；不扩大 Intel/最低 OS、完整 D06、native Fenced 或升级验收。原 JS 许可欠项继续存在。

## 证据

工作证据 `output/cua-launchservices/`：preimages、opening-files.json、workers.json、preflight-probe/source/signing/TCC log。完成后归档必要构建、来源差分、签名、测试及实际调用证据。

## 独立检查与首次实际启动

controller 在 Node24.14.0 下运行根 typecheck/lint/architecture，通过；lint301 warnings/0errors。受影响4组Host/CLI测试90项通过，worker沙箱里的2项ps权限失败未在controller复现。独立 native 重建6组测试通过、固定证书签名及包内Helper/Node strict verify通过。

首次系统启动 `controller-ui-reviewed`：2026-10-30 20:12:51，本机PID64856，未出现窗口，20:12:52以SIGTRAP退出，尚未执行本轮截图。发现两个确定的打包缺陷：fs.cp默认重写framework symlink成指向源Electron缓存的绝对路径；主Mach-O仍名Electron，导致实际开发态/profile Zody Dev。后者与[Electron41.0.3 IsPackaged实现](https://github.com/electron/electron/blob/v41.0.3/shell/browser/api/electron_api_app.cc#L846-L874)一致。两者随后已修正；SIGTRAP的单一原因不能仅从这两个静态缺陷断定。首次失败证据保留，不将worker构建成功记为实际启动通过。

第二次系统启动 `controller-ui-packaged`：修正14个framework相对链接及主/Chromium helper可执行名，实际完整UI打开（PID70801），profile为独立候选，包内固定Helper strict verify通过。Host relay71247启动LS child71252，但child约5秒后退出，UI显示Startup preparation failed；未执行截图。源码显示AppKit finishLaunching位于child_handoff之后，而父端等待NSWorkspace completion再交接；根据这次时序证据修正为复用同一ConfirmationController先finishLaunching，再handoff。失败进程均已退出，普通用户Zody未受操作。新native构建与6组测试通过，controller随后独立重建并签名，最终结果如下。

## 最终实际结果

完整候选为 `output/cua-launchservices/controller-ui-appkit/Zody CUA Launchservices Candidate.app`。通过系统应用入口启动；真实 Electron Mach-O、包内相对 resources、14个 framework 相对链接及独立 profile。UI PID76851/PPID1；Host Helper77278/PPID1与Node77279，CLI Helper77429/PPID1与Node77436。中间relay仅传输原fd5/6/7及stdio，无新授权状态。进程树见 `evidence/independent-checks/actual-process-tree.txt`。

实际最终采集 Helper 的 ScreenCapture 请求77429.2（20:31:50本地）在tccd中明确 subject=`io.github.zclaudia.zody.cua-helper`、authValue=2/authReason=4；路径是本候选包内Helper。最终截图20:39:28的replayd访问日志同样定位到该Helper。证据为 `tcc-live-capture.log` 与 `tcc-final-capture.log`；不以PPID1或probe代替TCC归属。本轮没有安装证书或更改系统权限。

真实app会话 `sess_52c2477b-1724-4aea-b07a-89e7a73afbf8`；最终turn `turn_86254783-b2b6-4f6e-96ed-76b137669828`，目标PID76851/window88476。用户点击逐次原生确认，控制器未代点。以下时间为UTC：

| 事件 | 时间 / 结果 |
| --- | --- |
| 真实截图交付 | 12:39:55.804，2400×1600 PNG，503797 bytes |
| PNG SHA-256 | `ec8953ab3fe269b0218f3f69ef735b1346dd540097d3f5a2e7d17039bc431921` |
| 截图资源与machine lease | 交付事件中resourcesReleased=true、machineLeaseReleased=true |
| 同turn等待工具启动 | 12:39:57.908 |
| 控制器点击实际UI Stop | 12:40:13.737记录user-stop、owner revoked、revision2 |
| 同一lineage | `9c9ec565-df76-46d9-9a50-5b36ff87a908`，截图与撤销一致 |
| 工具取消 | 12:40:13.751，TOOL_CANCELLED，撤销后14ms |

实际工具返回图经app预览下载并由controller独立查看：`evidence/independent-checks/actual-tool-launchservices.jpg`，2048×1365；JPEG属于现有结果转换，不与native PNG哈希混同。`actual-image.json`保存其摘要。图像为Zody目标窗口，非controller截图或模拟结果。完整必要事件见`live-events-final.json`。

截图资源已在Stop之前释放。因此此结果是已有submission/authority的撤销与工具取消，不是原生在途屏障/native Fenced，也不证明所有后代进程已经终止。之前两次未完成原生确认的请求120s超时；另一次截图成功后controller错过Stop时机，90s等待自然完成。它们均保留在事件证据中，不算Stop通过；独立Stop补测通过后，最终又完成上述同lineage的截图→Stop。

## 最终代码审查与必要检查

审查修正了：peer UID与geteuid比较、同audit token解析CDHash、NSWorkspace completion的主线程时序、SCM_RIGHTS数量/截断/关闭及stdio重映射、注入环境过滤、启动前后EOF/退出处理、同NSRunningApplication实例退出观察，以及先关闭rendezvous再清理（避免Quit绕过清理）。同一个ConfirmationController先完成AppKit启动，再交接到现有supervisor，消除了实测启动死锁。Host/CLI仍复用原submission、authority、machine lease、frame owner；旧direct模式和正常产品默认值不变。

controller检查：Node24.14.0下根`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`通过；lint301 warnings/0errors。最终native/packager修正后再次lint及architecture通过。受影响4组Host/CLI测试90项通过；真实native 6个测试程序通过。native固定arm64/macOS14.2部署目标编译链接通过，系统Swift rpath为`/usr/lib/swift`。固定证书签名，Helper及Node在外层app拷贝前后strict verify均通过。没有DYLD覆盖、复制系统库、关闭library validation、伪造Team ID或用ad-hoc作为可信身份。外层原版Electron保持不受信UI角色。

架构gate通过不等于对native内部边界完成机械证明：desktop当前managed=false。构建manifest中继承的unsigned/hostLoad静态限制属于builder不作运行保证；本报告实际签名及窄会话运行结果单列，不将它改写成完整Host功能通过。

## 来源、依赖与冻结

源文件清单 SHA-256：`11d49f9ff4303e3e1c7ed2dbcc9b5879227591f17be38201abd9451450c4d0eb`（清单摘要，不冒充前轮Rust冻结树摘要）。

本轮源快照及差分：`evidence/source-and-patch.tar.gz`，摘要清单`evidence/source-sha256.json`；对应本地展开目录`output/cua-launchservices/frozen-launchservices/`。差分优先对本轮opening快照；nodeHostEntryConfig仅有前轮冻结比较点，已在change-origins中显式标明，不能冒充本轮新增内容。未重置或覆盖其他任务的未提交改动，旧报告与R8–R11冻结源只读。

`native-build-manifest.json`保留继承来源、逐patch摘要、固定工具链、输入与构建产物；`ui-build-manifest.json`保留完整app装配、16个实际运行包及无node_modules外链结果；`entry-audit-and-licenses.tar.gz`保留实际entry依赖输入、esbuild图和许可材料。固定Node和视觉静态库与前轮一致，Rust视觉图30包未改变，本轮未修改第三方桥或registry缓存，也未重新宣称执行Rust全矩阵。entry包集合的既有许可欠项（169个唯一包、6项missing）没有因此解决，不宣称法律/采用通过。所有证据摘要位于`evidence/SHA256.json`。

最终包内已签名Helper SHA-256：`92a1b227213ebc894edc27cc9f5d20a4e57eb4db4843d1c487ff8b44cf37faa9`。`actual-artifacts.json`及codesign元数据记录最终Helper、固定Node与外层Electron的不同身份角色；构建前unsigned产物摘要不与签名后摘要混用。

## 当前边界与下一步

本轮“完整.app候选系统启动→Helper权限归属→真实截图→同owner Stop”已通过，功能仍默认禁用，`zcodeCuaPlaceholder=true`。没有改写普通已安装Zody或默认发行入口，也没有声明完整Computer Use上线。

下一阶段先把已验证装配收敛进正式发行构建，保持现有自签名与权限身份；正式启用前处理已知cell源码校验到exec之间的路径TOCTOU/完整D06隔离。窄候选暂不支持node-pty/SSH及部分可选native能力，不能替代完整Host。Intel/最低OS实机、升级身份稳定性、输入native Fenced和既有许可欠项仍未通过，均未在本轮扩验证。签名策略持续local-self-signed，不设迁移Developer ID或公证期限。
