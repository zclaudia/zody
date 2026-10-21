# Zody 0.1.0 人工验收场景

依据 [发布规格](../../specs/zody-0.1.0-release.md)。下面是验收合同，不能把已编写场景当作已执行结果；执行证据记录在 [仓库改造验证报告](../releases/zody-0.1.0-validation.md)。桌面实时链路与手机恢复链路分别验收。

| 场景            | 准备与操作                                                                                  | 通过条件                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 安装与帮助      | 干净安装并打开 Zody，检查关于、Help、Issues、更新入口                                       | appId/显示名/0.1.0 一致；跳转 zclaudia/zody；更新仅打开 Releases；没有上游社群入口                                      |
| 配置隔离        | 在旧用户目录放标记，启动空的 Zody 用户目录                                                  | 不读取、迁移或删除旧目录；新数据只写 `.zody`                                                                            |
| 项目双目录      | 同时准备新旧配置、skills、commands、MCP、hooks、workflows，包含同名及各自独有项             | `.zody` 同名优先、不同名资源可见；工作流中枢能刷新两目录变更；修改仅写 `.zody`；旧文件逐字不变；Hook 按有效声明重新信任 |
| 模型与任务      | BYOK 配置测试模型，新建任务，工具请求/拒绝/允许、停止、重开历史                             | 模型配置生效，执行和权限符合当前模式，停止后旧 run 不污染新任务                                                         |
| 浏览器          | 打开插件设置和 composer，执行 Browser Use 页面操作                                          | Browser Use 可用；没有系统级 Computer Use 占位入口或推荐                                                                |
| 原生/CLI 路径   | 在含空格路径解压，无系统 Node/pnpm，执行 help/version、TUI 和 Web                           | 使用包内 Node 与目标原生资源；四个首发平台分别记录证据                                                                  |
| Web 网络边界    | 默认启动；非回环无 token；恶意 Origin 与外域 Host；同源和原生客户端                         | 默认回环；非回环无 token 拒绝；跨站/重绑定不能访问 API 或升级 WS；合法客户端可工作                                      |
| SSH/WSL         | 使用随包本地运行时，创建、断开、重连远程 workspace                                          | 不使用 CDN 回退；保持 identity/owner/lease；WSL 在 Windows 验证                                                         |
| Android/gateway | 使用实际 release key 安装，配置自有 gateway；凭据拒绝、选择桌面、任务、权限、断线及桌面重启 | APK 身份和签名正确；复用已有 Host attachment；snapshot/replay 恢复；不为手机新建运行时                                  |
| 隐私与诊断      | 正式构建无上报变量，尝试注入 endpoint；导出日志                                             | 注入上报配置构建失败；正式 Host 不继承外部上报配置；只由用户手动导出诊断并审查内容                                      |
| 发布晋级        | 推送版本 tag 的受控演练，检查草稿和摘要，重试失败 job                                       | 仅草稿 Pre-release；制品矩阵完整且摘要正确；不替换公开同版本；人工验收后才公开                                          |

已有设置 E2E 在 `packages/desktop/test/e2e/settings/settings-ui-polish.test.ts` 覆盖不可用 CUA 隐藏与 Browser Use 设置入口；目录、鉴权和密钥边界由相关 integration/unit 回归先行验证。真实平台、设备、gateway 与公开发布流程仍需按表补齐运行证据。
