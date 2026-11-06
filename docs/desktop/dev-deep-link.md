# Desktop Dev deep link

macOS 开发启动为当前 checkout 的 Electron runtime 准备 `Zody Dev.app` 副本，位置在 `.zody-runtime/desktop-dev/`。副本声明 `zody-preview` scheme，与 Dev 运行时的 Preview 系统集成身份一致；正式版使用 `zody`。

`pnpm dev:desktop` 和 `pnpm dev:desktop:test` 继续使用各自环境配置。开发副本保留 Vite、HMR 和现有单实例行为，不修改 `node_modules/electron`。

当前支持的 workspace deep link 为 `zody-preview://workspace/open?path=<encoded-absolute-directory>`；原 Share import 功能已移除。系统注册后，外部链接经 macOS open-url 或 second-instance 交给运行中的 Desktop，由 main 校验并投递给 renderer。
