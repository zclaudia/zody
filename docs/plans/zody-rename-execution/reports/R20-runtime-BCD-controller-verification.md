# R20 runtime B/C/D：主控复核

基线 `01f59a33c1c54a4a5102d0917cd64b3c678e0d4c`。主控逐个核对最终 1121 文件 before/after SHA 与精确变更集合，319 条声明另登记于 symbol ledger。范围包括实际动态导入、反射导出名、内部 helper 属性、JS/MJS 消费者及两个会真实启动的 OAuth TypeScript 子进程 fixture；不是只检查 TS 主项目。29 处 shorthand 按 owner 保留外部键或同步内部键。图只改 10 个已迁移符号叶子，372 节点、726 边不变。尚未触碰的独立服务集合成员属于后续 R20.4。

主控独立验证日志位于 `output/zody-rename-validation/runtime-bcd/`，实际 argv/cwd/退出码分别见 `commands.json`、`runner-corrections.json` 和 `final-followups.json`：

- 根初次 49 文件：572 项通过、7 项失败，退出 1；均为 Web relay 测试 mock 缺少现行 `connectViaProtocolOwned`。干净固定 7c 祖先实际复现相同 7 失败/4 通过。补齐返回 services/dispose 的 mock、保留所有恢复断言后，主控目标 11/11，退出 0。没有声称首次整套命令通过。
- UI 最终使用仓库根受控项目配置，实际 319 文件：317 文件通过、2 文件失败，3414 项通过、2 项失败。两项分别为测试期望 100vh 而组件使用 100dvh、remoteAccess 期望对象缺少 allowMobileOpenArbitraryPath。干净 7c 祖先两个文件实际 30 通过/2 失败；四个直接源码/测试相对 7c 与 01f 仅 Intl hook 名称变化。保留既有失败，不修改 UI 规则或断言来获得通过；基线证据不冒充所有间接依赖相同。
- CLI 初次错误地将 10 个 TUI Node 测试交给 Vitest；另两份 OAuth 测试有 5 失败及 1 个未处理错误，原因是两个活跃子进程 fixture 仍导入旧 credential factory。初次结果为 47 文件通过、12 文件失败，688 项通过、5 项失败。同步 fixture 后，主控两文件 13/13、退出 0；正确 TUI Node runner 131/131、退出 0。CLI 其余 11 个 Node 测试文件 312/312、退出 0。原错误命令及其完整日志均保留。
- 图测试 4/4；最终根 typecheck 和 lint 退出 0，303 warnings。主控独立隔离 HOME/USERPROFILE/TMPDIR、仅保留 PATH/LANG 的 compact fake 7 个场景全部通过，退出 0，临时目录随后删除。CLI 强制 build 23/23、强制 typecheck 34/34、零缓存及 changed architecture 通过来自实施者真实记录，未重复构建。
- Desktop Main 单独检查退出 1、85 条诊断；与 A 批日志仅双引号字面量联合类型排列不同，排序后全文一致，无名称/行号映射，无新增/消失诊断。仍不通过，见 `main-comparison.json`。

主控 UI runner 的两次调用错误单独记录于 `runner-provenance.md`：首次包 cwd 导致重复路径 ENOENT；第二次从根使用最小 UI 配置误采集 output 内旧快照，发现后对本任务确切 Vitest PID 发送 SIGINT，退出 130。该部分运行不作候选证据。最终使用根配置的 managed includes、aliases 和 setup；产品文件集合/哈希随后重新核对，未为错误调用修改源码。TUI 的 runner 错误也已独立纠正。

本批准备交独立 DeepSeek 审查。原构建失败、fixture 失败、runner 错误及既有 UI/Main 失败没有删去；完整 R21/R22、原生 Desktop、最终容器和发行门禁仍未完成。剩余内部成员、少量 JS 局部声明及当前文字清理由后续 R20 收口。
