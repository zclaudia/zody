# Zody 0.1.0 仓库改造验证

本报告记录仓库实现与本机验证，不表示已经推送 tag、运行 GitHub Actions、创建公开 Release 或完成全部平台验收。首发产品规则见 [规格](../../specs/zody-0.1.0-release.md)，人工验收入口见 [验收场景](../testing/zody-release-acceptance.md)。

## 已实现

- 产品/桌面身份 Zody、`io.github.zclaudia.zody`、`zody://`；公开版本读取根 `package.json` 的 `0.1.0`。公开文档、反馈和手动更新入口使用 `zclaudia/zody`。保留内部包名、协议标识、原作者与第三方版权。
- 用户级数据只使用 `.zody`；项目配置、技能、指令、MCP、Hook、工作流、计划与记忆按各自规则兼容 `.zcode` 读取，写入只进入 `.zody`；删除旧目录工作流或删除后会显露旧定义时返回只读错误，并提供中英文处理提示。Hook 的配置变更复用跨进程锁，信任仍按有效声明审查。
- CLI/Web 四目标自包含构建、目标运行时与原生资源、摘要、tag 校验、草稿 Pre-release 工作流。自动更新/ARMS/遥测/打包 OTEL 关闭，注入上报配置会失败。不可用的系统 CUA 入口隐藏，Browser Use 保留。
- HTTP 默认回环、非回环必须 token；API/WS 校验浏览器 Origin，未鉴权回环入口拒绝外域 Host。CLI 与 services 共用随机凭据密钥，丢 key 或损坏时拒绝覆盖已有密文。
- Android 显示名、namespace、applicationId 和根版本接入；release signing fail-fast、CI Secrets 接口与配置文档。

## 工作区保护

实现位于独立临时 worktree，开工时的改动另作快照；持续并入主工作区独立 SSH/WSL 改动，并保留其本地离线运行时方案。本地 `origin` fetch/push 为 `git@github.com:zclaudia/zody.git`。没有恢复被删除模块、重置用户文件、自动迁移旧数据或推送提交。

## 本机证据

验证环境为 macOS arm64，主要命令使用固定 Node.js 24.14.0；Android 使用本机 JDK 21 与 SDK 36.1。

| 验证                             | 结果                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 根类型、Lint 与架构              | `pnpm typecheck` 通过；`pnpm lint` 0 errors、310 warnings；架构检查 0 violations（已在主工作区同步后复核）                                                                                                                           |
| CLI 标准类型/Lint                | 类型检查 30 个任务通过；Lint 14 个任务通过，存在历史 warnings                                                                                                                                                                        |
| HTTP Origin/Host、监听与原生连接 | 14 项 integration/unit 通过；已验证坏 Origin、重绑定 Host、token 和合法客户端                                                                                                                                                        |
| 工作流 UI 双目录监听与预览       | 20 项通过，包含 Windows 路径与迟到 watcher 清理                                                                                                                                                                                      |
| 新凭据密钥与并发                 | 密钥并发/损坏/丢失、CLI/services 互读与跨进程 Hook 锁回归通过                                                                                                                                                                        |
| macOS arm64 CLI/Web              | 最终源码完整构建、SEA、打包与归档启动通过；PATH 无 Node/pnpm、含空格路径、help/version、Web HTTP 200；PTY 无参数启动显示 Zody 并进入 TUI，Ctrl+C 退出（130）                                                                         |
| Android                          | release APK 构建和 debug 单测通过；临时测试密钥签名经 apksigner 验证；aapt 确认 appId、versionName 0.1.0、versionCode 1                                                                                                              |
| 初轮完整根单测                   | 1653 文件：1636 通过、14 失败、3 跳过；14802 项通过、70 失败、17 跳过。涉及旧品牌/目录 fixture、HTTP 安全用例及高并发文件监听超时；修正后同组 14 文件重跑全部通过：260 passed、1 skipped。不将初轮写成整套通过                       |
| CLI 测试材料                     | 补入被 gitignore 遗漏的 13 个 lowering 期望快照；lowering/hole-sites 定向 869 项通过。限制任务和 worker 并发，不延长同步/计算超时；最终 `pnpm --dir apps/zcode-cli test --continue` exit 0，36/36 tasks 成功（17 cached），耗时 5m9s |
| 格式与补充回归                   | 本次改动的根目录及 CLI 文件分别经 oxfmt 检查通过；`git diff --check` 通过。只读工作流删除 UI 15 项、schema 13 项及路径错误传播用例通过                                                                                               |
| 第三方材料                       | 基础新鲜度通过；严格检查被 19 项待补材料阻断                                                                                                                                                                                         |

最终 macOS arm64 核验归档 SHA-256 为 `40154be2d89fca012162ba7062151b9f9eb3d9c6a5f84e2c54ad33985520929c`，位于本机临时目录 `/tmp/zody-release-1792510867/zody-smoke/releases/0.1.0/zody-cli-0.1.0-darwin-arm64.tar.gz`。本地 CLI 归档为 `verificationOnly=true`，不是可发布候选。Android 使用的临时验证密钥在仓库之外，不能作为正式签名或离线备份。公开 release signing 需要维护者提供自己的专用 keystore 与四项 Secrets。

## 公开发布前仍需完成

1. 补齐 `third-party/inventory.json` 的 19 项原始许可/版权/链接来源证据；严格门禁必须通过。不能用生成声明或更新字段消除真实缺口。
2. 提供、离线备份 Android release keystore，设置 GitHub Secrets，并用实际签名真机安装及升级。
3. 在 macOS x64、Windows x64、Linux x64 实际构建/安装和验证 CLI/Web；本机成功不代表这些平台通过。
4. 在真实 Android、gateway、桌面与 Windows WSL 环境验收连接、权限、断线恢复和升级；补齐桌面设置及目录兼容 E2E 运行证据。
5. 从干净 checkout 运行 GitHub Actions tag → 全检查 → 矩阵制品 → 草稿流程，人工核对摘要和包内容后再公开 Pre-release。该流程本轮未触发。

严格许可门禁、实际生产签名与跨平台/设备验收未完成前，不能把仓库实现状态写成“可以正式发布”。
