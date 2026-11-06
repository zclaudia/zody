# R20 Dynamic Workflow launch 文档尾项

基线 `371acd17f4ffa49a3f6706668f177c10e8a4d60e`。本批按已审映射修正 24 处当前文档中的源码路径、当前写入目录、CLI/服务符号和两条中文 UI 原文；其中包括先前冻结的 9 处。具体逐项和证据见 `output/zody-rename-r20-launch-doc/implementation/full-mapping.json`，前一冻结清单另存 `source-hashes-nine-mappings.json`。

保存定义的查找顺序明确为当前项目根、legacy 项目根、当前全局根；不改历史文件。草稿和 run entry 的新写入根依据 `workflow-drafts.ts` 和 `child-entry-file.ts`，不能把保存定义的 legacy 读取推及它们。freshness 说明现行实现会请求监听当前和 legacy 两个项目目录；目录不存在等原因可使单个监听失败并记录 debug，成功监听后保持 300 ms 防抖。

保留的五处 `zcode-workflow` 是当前实际持久文件格式 sentinel，现无获批迁移；这不是对整个改名计划作永久豁免。文中另有两处 `.zcode/workflows`，分别准确描述 legacy 查找与监听请求；完整剩余旧词分类见 `remaining-old.json`。已验收的 single-executable 段与历史冻结内容保留。

本批仅修改文档，不改代码或协议。固定 Node freshness 与 `git diff --check` 通过；不需要构建或运行产品测试。此记录不代表整个 R20 或发行验收完成。
