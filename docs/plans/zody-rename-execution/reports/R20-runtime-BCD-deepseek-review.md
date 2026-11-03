# R20 runtime B/C/D：DeepSeek 独立审查

**结论**

`PASS`（scoped：R20.4 runtime B/C/D，固定 `01f59a33c1c54a4a5102d0917cd64b3c678e0d4c` → `21c06e804020be17dc4dde62fbc0ee4d2b96beb4`）。未发现产品/测试/账本阻断项，无需 `CHANGES_REQUIRED`。本次未修改任何文件。

**审查证据（固定对象 + 只读实测）**

- 父提交确认正确；`1128` 文件 = `1121` 产品/spec/graph + `7` metadata。无 rename/delete，`A` 的 4 个文件全部是新增审查报告；`scope.runtimeBCDBatch.sourceFiles` 与 1121 集合逐项相等。
- 独立对 1121 文件全部 before/after blob 计算 SHA-256：`2242/2242` 与 `file-hashes.json` 一致；diff 为 `+10419/-4868`。
- 变更内容未越界：仅 4 行改动不含 zcode/zody 字样，均为已披露的 Web mock 修正和 spec 说明；未改 `package.json`、`pnpm-lock`、CI、`mise.toml`、`third-party/copied-components.json`、env/wire/lock 或 native/frozen 制品。
- 319 条 ledger 记录：319 行对应 308 个唯一符号名、336 个实际新声明位置；所有记录的新声明均存在于固定源码的记录坐标，无旧函数/类/变量声明残留。记录文件之外的旧声明仅剩测试局部名、deferred `loadZCodeModules` 等已知项；活跃 import/export 扫描无旧名残留。
- 29 个 shorthand owner 核对为：8 个外部/R44 键 + 15 个 deferred 内部成员 + 6 个纯 helper；`basedOnZCodeBuiltinRevision`、插件桥 `zcode`、provider-node/host builtin 键均保留；`IServiceAccessor`/`RemoteServiceAccess` 成员明确留给后续 R20.4，未被说成 wire 例外。
- 动态消费者：compact `case-utils.mjs`、memory 两文件、`scripts/builtin-provider-config.mjs` 均指向现行 `createZodyApp`/`decodeZodyBuiltinRelease`；manual E2E 6 个脚本及 feedback fixture 使用现行 `ZodyIntlProvider`/DI；两个 OAuth 子进程 fixture 仅改 factory 名，credential payload 未变。
- 图独立解析 YAML：前后均 `372` nodes / `726` edges，恰好 10 个 leaf 变化；9 个唯一新 symbol 均为固定源码真实 export。
- Metadata 为 additive bookkeeping：A 批已标 PASS，B/C/D 仍为 `controller-verified-pending-DeepSeek`；未放宽冻结/范围约束。`candidate:null` 与既有 pending-review 批（如 R20.5）约定一致，PASS 后应由主控补 `21c06e80`。

**测试证据（仅读日志，未在只读沙箱重跑）**

- Root 初次 49 文件：572 pass / 7 fail；固定 7c baseline 复现 7 fail / 4 pass；Web mock 修正后 11/11。UI 最终 319 文件：3414 pass / 2 known fail（100vh-vs-100dvh、remoteAccess 缺 `allowMobileOpenArbitraryPath`），7c 复现 30 pass / 2 fail，4 个直接源码/测试仅 Intl 名称变化。
- CLI 初次 47 files pass / 12 fail，688 pass / 5 fail + 1 error；纠正后 TUI 131/131、CLI Node 312/312、OAuth 13/13。Graph 4/4；隔离 compact fake 7/7。
- Root typecheck 0、lint 0 errors / 303 warnings、changed architecture 0；CLI force build 23/23 零缓存、force typecheck 34/34 零缓存。Main 仍 85 diagnostics，归一化双引号 union 顺序后与 A 批全文一致，未把 Main 说成通过。
- 证据见 `docs/plans/zody-rename-execution/reports/R20-runtime-BCD-controller-verification.md`、`output/zody-rename-validation/runtime-bcd/`、`output/zody-rename-r20-runtime-next/runtime-closure/bcd-implementation/`。上述测试/构建为日志复核，不是我的独立重跑；只读环境未生成临时 HOME、未 install/build/WDIO/访问真实数据。

**非阻断观察与边界**

- 319 条 inventory 记录中含 11 条重复行（`zcodeTaskService` 4、`zcodeBuiltin` 7、另两组各 2），故唯一符号名为 308、实际声明位置 336；底层声明均已迁移。若报告写成“319 unique symbols”应改为“319 records / 308 unique”，这是措辞/账本问题，不是产品缺口。
- 已知残留：两个 `loadZCodeModules` JS 局部绑定、测试局部变量、注释/错误字符串、`zcodeType` 日志标签、deferred 服务成员，以及 `apps/zody-cli/e2e/memory/README.md` 的旧 `createZCodeApp` 文案；均属于后续 R20 清理，不构成本批阻断。
- 既有边界保留：UI 2 失败、Main 85 失败、完整 R20/R21/R22、原生 Desktop、容器/发行/CI/签名/真实 release smoke 尚未完成；本 PASS 仅为 runtime B/C/D 固定候选范围，不代表 full gate。
