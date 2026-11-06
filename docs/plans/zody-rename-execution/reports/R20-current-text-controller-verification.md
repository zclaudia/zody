# R20 当前文字和 JS 小绑定：主控复核

基线 `66af64363af06f2729c3a725ebc9e06dc71964c3`。主控核对 87 个当前产品/spec/文档文件的全部 before/after SHA 和实际集合；成员批的代码保留，重基没有覆盖其新字段。7 个 JS 文件逐字节等于基线仅替换两个独立 loader 的同名绑定及 fixture 自有 schema 名；另以 TypeScript AST 独立比较字符串与模板 literal 多重集合，7/7 一致，见 `output/zody-rename-validation/current-text/js-literals.json`。辅助检查脚本第一次因 execFileSync 参数类型错误未运行成功，修正调用参数后取得上述结果，未为检查修改产品。

主控独立验证：根三个目标文件 16/16、dev-docs 七文件 18/18、根 typecheck、lint 均退出 0；lint 303 warnings。在独立临时 HOME/USERPROFILE/TMPDIR、仅保留 PATH/LANG 的环境运行 compact fake，7 场景通过；按 memory 包实际 e2e:bench 脚本直接调用固定 Node，4/4 通过。均使用当前已有构建，不替代最终完整候选干净安装/构建。临时目录随后删除。

证据为 `output/zody-rename-validation/current-text/`。初始主控 wrapper 在前五项成功后，因隔离 PATH 不含 pnpm，未能启动 memory 命令；wrapper 整体退出 1，不称为整体通过。前五项明确的子进程退出码从工具 stdout 保存于 `partial-results.json`，实际 memory 命令单独记录于 `memory-command.json`；未重复已通过检查。实施者额外的 process manager、CLI/TUI runner、路径检查和 changed architecture 结果见实施报告。

协议 wire 名、五个 Error.name、ServiceChannels、环境变量、旧输入、第三方身份及冻结材料按现行 owner 保留。graph 自身旧 basename 交 R21 精确路径闭合；其后的 notices/inventory、干净候选和最终 R22 尚未完成，不能把本批验证当作完整改名/发行通过。
