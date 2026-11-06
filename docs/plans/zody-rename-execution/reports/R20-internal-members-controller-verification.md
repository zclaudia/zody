# R20.4 内部成员：主控复核

基线 `21c06e804020be17dc4dde62fbc0ee4d2b96beb4`。主控核对 142 个产品文件的全部 before/after SHA 和实际变更集合，另审 spec 的访问器成员与 RPC channel 边界，范围一致。三个成员名称涉及 198 个 checker 符号组、493 绑定引用，配合已定位的未解析测试替身、索引类型、反射数组和诊断，共 516 个精确编辑位置。真正通道文件未改；成员名不被当作远端 channel 值迁移。

主控独立执行 14 个本地/远端访问器、workspace identity、服务/插件、连续流、手机通知和 UI 恢复测试，115/115 通过；对根配置不收集的 client 源码旁 sampling 测试，使用限定该文件的独立配置，1/1 通过。根 typecheck、lint 均退出 0，lint 303 warnings。精确 argv/cwd/exit 在 `output/zody-rename-validation/internal-members/commands.json`；没有再次运行未修改的已知 gateway 失败用例或无消费者的 CLI 构建。

实施者更广的根运行实际收集 65 文件，772 项通过、1 项失败；未收集的 source test 已单独运行通过。唯一 gateway 断言期望协议上限 3、实际 4，在干净 7c 祖先实际复现 19 通过/1 失败；三个直接测试/实现/channel 文件跨版本 SHA 相同，不把所有间接依赖说成相同。实施者还完成真实浏览器 onboarding 四场景及 mobile settings 两条脚本，均退出 0；主控读取日志和代码变更，未重复浏览器执行。Main 单独类型检查仍退出 1、85 条诊断，按三个成员名及既有 union 排列归一后与 B/C/D 全文一致，未改行号。这些既有失败不记为通过。

TS/跨语言 AST 审计、真实生成的 accessor/remoteServiceAccess 声明、ServiceChannels 字节一致性及 literal 审计见实施报告和 `output/zody-rename-r20-internal-members/`。源码旁测试的额外配置仅在 output 目录，include 限定当前唯一源文件，未扩大到旧快照。当前文字/JS 小绑定、R21/R22 和发行门禁仍待后续完成；本批准备交独立审查。
