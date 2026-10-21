# Zody Desktop 品牌与帮助入口规格

状态：按 `specs/zody-0.1.0-release.md` 已确认的首发决策实施。

## 产品规则与状态所有者

- Desktop 正式身份由 `packages/desktop/scripts/desktop-product-identity.mjs` 提供：产品名 `Zody`、appId `io.github.zclaudia.zody`、Linux 命令/包名、desktop 文件名和图标名均为 `zody`、协议 `zody://`。Preview 构建保留独立安装身份，Linux 命令/包名/desktop 文件名/图标名均为 `zody-preview`，且使用 `zody-preview://`，不覆盖正式安装。
- electron-builder 消费上述身份配置系统安装信息和协议处理器；deep link parser 接受 `zody://` 与 `zody-preview://` workspace-open URL。
- UI 的公开文档、反馈和更新链接指向 `https://github.com/zclaudia/zody`、其 `docs/`、`issues` 和 `releases`。更新操作只打开 Releases 页面，不触发自动下载或安装。
- 没有 Zody 社群 URL 时，帮助菜单、标题栏菜单和 Quick Pick 都不显示社群入口。`config/default.json` 不得带入上游反馈或社群 URL。
- Web 页面标题和窗口标题显示 Zody 名称。不可用的系统级 Computer Use 入口在用户界面隐藏，内嵌 Browser Use 保持可用。

## 验收场景

1. 生产与 Preview identity 单测分别验证 appId、显示名、可执行名、包名、Linux desktop 文件名/图标名和协议；正式 appId 与 Windows AUMID / macOS、Linux 注册信息一致。
2. 深链单测验证 `zody://workspace/open?path=...` 与 `zody-preview://workspace/open?path=...` 可解析。
3. 帮助菜单、标题栏菜单和 Quick Pick 的回归测试确认没有社群入口；文档、Issues、Releases 操作打开 Zody GitHub 地址。
4. Desktop E2E 验证用户打开帮助菜单后可到文档和 Issues，手动更新入口打开 Releases；确认没有上游社群或自动更新检查动作。
5. Web main 和 mobile remote document titles 使用 Zody；默认配置没有上游公开链接。
6. 设置与输入框不呈现系统级 Computer Use 插件/入口/推荐项；嵌入式 Browser Use 推荐与入口仍可用。

## 边界

该工作只改 Desktop 安装身份与协议注册、UI 的品牌/公开帮助入口、Web 对外标题和默认帮助配置。不重命名内部 `@zcode/*` 包、RPC 标识、协议字段、服务端点、版权信息或许可证归属。

## 工作流目录显示与监听

项目保存预览只展示 `.zody/workflows/<name>.dwf.ts`；全局预览为 `~/.zody/workflows/…`。项目中枢同时监听新旧工作流目录，任一目录发生变更都刷新同一服务端列表；列表与同名优先级仍由 Agent store 持有。全局只监听协议返回的单一目录。effect 清理和异步监听迟到结果必须逐一释放，不增加 UI 资源列表副本。验收覆盖 Windows 路径、新旧目录变化、workspace 切换后旧 watcher 释放。
