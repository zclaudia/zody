# Desktop Bundle Size Architecture

桌面端打包现在改成“两套资源明确分层”：

- desktop 本地 agent 运行时按当前平台准备后进入安装包
- SSH/WSL remote 资源按当前版本 manifest 引用闭包暂存到 `resources/remote-runtime/`，以压缩归档随包分发

## 目录约定

- `packages/desktop/bundled-agents/<platform>/`
  - 当前目标平台的最小运行时目录
  - 当前产品路径只要求 `glm/`
  - 同目录下会生成 `*-<platform>.tgz` 归档，便于审计和后续远程分发复用
- `packages/desktop/mock-cdn/`
  - 开发态 remote 资源入口
  - 统一按 `releases/<version>/...` 布局保存 `node`、`server`、`node-pty`、`glm`、`tools`

## SSH/WSL 本地资源策略（0.1.0）

规格：`specs/ssh-wsl-local-runtime-restoration.md`。

- `prepare-prebuilds.mjs` 生成四平台 `releases/<version>/manifest-<platform>.json` 与 `components/...` 内容寻址归档。
- `pnpm --filter @zcode/desktop stage:remote-runtime` 校验 schema、版本、平台、挂载点、必需文件与归档 SHA-256，仅复制当前引用闭包到 `packages/desktop/resources/remote-runtime/`。
- electron-builder 的 beforePack 强制校验/暂存；extraResources 将其复制到安装包 Resources/remote-runtime。普通 bootstrap 可跳过远端准备，正式打包不能跳过缺件检查。
- Main 在打包态提供随包目录，开发态提供本地 mock-cdn 目录，均注入 `assetSource: { kind: "local-only", rootDir }`。Host 复用现有部署事务与本机上传安装器。
- 缓存以 manifest 内容身份和不可变 generation 隔离，验证真实文件内容后复用；原子切换指针，不删除其他窗口仍在使用的 generation。
- 缺件、损坏、错误版本或平台直接失败。旧 remote-download 选择、CDN 环境变量和开发态 CDN 开关均不能改变 Desktop 的本地来源策略。
- `ZODY_REMOTE_ASSET_CACHE_DIR` 仍可覆盖可写缓存目录；shell 优先于本地 env 文件。`pnpm dev:desktop:remote-prod` 仅用于复用生产态 cache，不再启用资源网络下载。
- 独立 server 的显式 CDN 安装器仍保留，Desktop SSH/WSL 不调用该来源；不能把独立后端的测试当作 Desktop 的资源规则。

## agent 准备链路

当前 desktop 与 remote 默认都使用编译后的 `zody.cjs`，不再按平台下载内嵌 Node 的原生
`zcode-agent`：

1. `scripts/build-desktop-agent-cli.mjs` 构建 `apps/zody-cli/packages/cli/dist/zody.cjs`，并构建、校验
   CUA 等 Dev 必需的官方插件 runtime。`pnpm dev:desktop` 在 `pre-dev` 后执行该脚本，开发态 resolver
   优先直接使用 workspace 内的 bundle。
2. 桌面打包的 `prepare:agent-bundle` 将 `zody.cjs` 和官方插件 seed 资源写入
   `packages/desktop/bundled-agents/<platform>/glm/`，再由 electron-builder 复制到安装包。
3. remote 资产的 `prepare-prebuilds.mjs` 复用同一份 `zody.cjs`，写入各平台
   `packages/desktop/mock-cdn/releases/<version>/glm/<platform>/` 后产出 component artifact；远端使用已部署的
   Node 执行该 bundle。

`scripts/download-glm.mjs` 与 desktop `prepare:glm` 仅保留为手动兼容兜底，不进入默认 Dev、桌面打包或
remote 资产准备链路。

这样做的原因：

- release generator 不再准备三方 agent runtime
- 让 desktop、web、remote deploy 都消费同一份 ZCode Agent 资源结构
- 避免把开发态 `node_modules`、跨平台 native、调试符号和缓存直接带进安装包

### 开发与发布的一致性

Desktop SSH/WSL 的本地来源策略不允许用工作树中的开发 Agent bundle 覆盖已校验组件；修改 Agent 后应重新执行 `pnpm prepare:remote-assets`。manifest、安装字节与远端 SHA 标记必须对应同一快照。

四平台原生资源仅以 manifest 引用的压缩组件归档进入 Resources/remote-runtime；不能把整个 mock-cdn 或松散跨平台二进制复制进 app.asar、本地 glm runtime 或 node_modules。

## 哪些资源禁止进入安装包

- 本地 agent 目录里的非当前目标平台 native
- `node_modules` 里的非当前目标平台 native package / prebuild
- renderer 已经完成 bundle、桌面 Node runtime 不会加载的 optional native dependency；当前包括
  `pdfjs-dist` 为 Node 环境声明的 `@napi-rs/canvas*`
- `node-pty/build`、`node-pty/bin` 和非当前目标平台的 `node-pty/prebuilds/<platform-arch>`；桌面包
  只保留 `node-pty/prebuilds/<target-platform-arch>`
- 仅用于准备目标 prebuild 的 `@lydell/node-pty-*` 包；Linux 打包在 `beforePack` 将目标二进制复制到
  `node-pty/prebuilds/<target-platform-arch>` 后也必须排除这些源包
- `mock-cdn/`
- `*.map`
- `*.pdb`
- `*.tgz`
- `*.tsbuildinfo`
- `docs/`、`doc/`、`man/`
- `example/`、`examples/`
- `test/`、`tests/`、`__tests__/`
- 非许可证 markdown

## 审计

`packages/desktop/scripts/audit-bundle-size.mjs` 在常规 bundle 流程中校验最终发行文件大小，当前各类安装包阈值为 500 MiB；目录包验证不等于通过该压缩制品大小门禁。随包资源仅保留当前 manifest 引用闭包，避免历史组件累积。

除安装文件大小阈值外，`electron-builder` 的 `afterPack` 和 bundle 完成后的机械审计还必须校验：

- 安装包中不存在 `@napi-rs/canvas*` 和 `@lydell/node-pty-*`
- `node-pty` 只包含当前 `targetPlatform.key` 对应的 prebuild，不包含安装机或其他目标平台产物
- `.node`、`.dll`、`.dylib`、原生辅助 `.exe` 以及 node-pty 的无扩展名 helper 在 asar header 中
  标记为 unpack，不得同时作为 packed payload 留在 `app.asar` 并在 `app.asar.unpacked` 再保留一份

asar 内容审计必须由 Node 直接调用项目锁定版本的 `@electron/asar` CLI。禁止通过 `pnpm exec asar`
获取待解析输出，避免 workspace engine warning 等 pnpm 诊断信息混入 stdout 后被误判为 asar 条目。

`pnpm-workspace.yaml#supportedArchitectures` 只控制工作区安装阶段允许准备哪些平台依赖，不能作为安装包
资源边界。最终安装包资源集合必须由 `ZODY_TARGET_OS` / `ZODY_TARGET_ARCH` 决定。
