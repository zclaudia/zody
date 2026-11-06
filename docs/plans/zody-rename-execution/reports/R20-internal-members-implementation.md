# R20.4 服务访问器及内部成员

基线 `21c06e804020be17dc4dde62fbc0ee4d2b96beb4`。先更新 `specs/zody-brand-residual-cleanup.md` 的访问器/通道边界，再以 TypeScript source checker 对三个旧成员建立 198 个符号组和 493 个绑定引用；9 处未解析引用均是 `hostRemoteWorkspaceServices.test.ts` 本地 fake 的属性读取，已按实际构造一并更改。`candidate.json` 记录每组声明、逐位置编辑和 142 个产品文件的前后 SHA；另有 spec 一份，最终比对见 `final-audit.json` 与 `contract-and-declarations-audit.json`。实施者未修改 ledger、scope 或锁文件；主控在实施后追加了审查 receipt 和账本/scope 元数据，最终提交包含这些独立记录。

`IServiceAccessor`、`RemoteServiceAccess`、Desktop 远程 workspace、本地 helper/adapter/plugin 依赖、UI 和 Web 的服务成员统一为 `zodyTaskService`、`zodyAgentService`、`zodySessionService`。Desktop `legacyRemoteWorkspaceRpcContract` 的字符串数组反射访问器本地属性，因此同步修改数组和测试诊断；indexed-access 类型及两条活跃 mobile E2E fake 也同步。实际 `ServiceChannels` 文件前后 SHA 完全相同，`zcode-task`、`zcode-agent`、`zcode-session` 值保持，未改 wire、env、builtin 或插件桥身份。

`source-literal-audit.json` 对非测试产品源码的 AST 字符串多重集合比较：差异仅为访问器索引类型与上述反射字段数组；不覆盖模板运行结果。重跑 source checker 得旧成员标识符和精确字符串 0（`post-binding-inventory.json`）；对 8,355 个 tracked TS/JS 文件的 AST 复核也为 0（`cross-language-post.json`，排除冻结 native 和声明文件），另核对 54 个 tracked d.ts 无旧成员。已有历史/当前说明文字不在本批做词法替换，交 R20.5。源码真实重建的 `packages/services/dist/accessor.d.ts` 和 `packages/client/dist/remoteServiceAccess.d.ts` 均包含三个新成员，SHA 见合同审计。CLI 工作区没有这三个成员的消费者或本批改动，因此没有无关的 CLI build/typecheck。

所有日志位于 `output/zody-rename-r20-internal-members/`，包含 cwd、完整 argv 与真实退出码：

- 根 `pnpm typecheck`、`pnpm lint`（303 warnings、0 errors）、`pnpm architecture:check --changed` 均 exit 0；spec `oxfmt --check` exit 0。
- 根 Vitest 明确请求 66 个文件，根配置实际收集 65：64 文件通过、1 文件失败，772 项通过、1 项失败，整体 exit 1（`root-tests.log`）。包含 Desktop 连续流、远端服务集合、Web 可恢复连接及相关 UI/adapter 的受影响测试。未收集的是源码旁 `packages/client/src/remoteServiceAccess.sampling.test.ts`；以输出目录内独立 source 配置从根 cwd 额外运行，1/1 通过、exit 0（`source-test.log`）。
- 唯一失败为未修改的 `mobileRemoteGatewayTerminalTransport.test.ts:511`：期望 `appProtocol.max=3`，实际 4。同测试在干净 `7c4ff9113680a38e273032b09bee32ee6ba399af` 检出按根配置运行，19 通过、1 失败、exit 1；测试、transport 和 shared channel 三个直接文件在 7c、21c 和当前版本 SHA 均一致。完整日志和 `gateway-baseline-comparison.json` 记录证据；该比较不证明所有间接依赖相同。
- 两个活跃 mobile manual E2E 使用现有 `pnpm exec tsx` 真实浏览器 runner：`mobile-remote-onboarding.mjs` 四个 attached/server × completed/dismissed 场景通过，`mobile-settings-connection.mjs` 通过，均 exit 0。两者在独立临时数据/新建本仓 `.tmp` 产物目录运行。
- Desktop Main 单独 `pnpm exec tsc -b packages/desktop/tsconfig.main.json` exit 1，85 条诊断。与前一 B/C/D 主控日志相比，按本批三成员名称和已允许的联合类型排序归一后，完整文本一致，未改行号（`main-comparison.json`）；Main 仍不能称为通过。

本批不声称完整 R20 已完成；旧命名注释、后续协议代际与其他 runtime 领域按既定 owner 继续处理。
