# R21 最小生成输入：主控复核

主控从当前提交原文独立重建预期结果：feature graph 只替换两个带引号的 `symbol` 值；copied-components 只替换三个已移动文件的路径。实际文件与这五处替换后的预期逐字节相同，其他内容保持不变。初次本地校验错误假定 YAML symbol 不带引号，断言未通过；按实际 YAML 语法修正校验后通过，未因此修改产品。

三个被引用文件的 SHA-256 分别为 `60fa5acd9f5c357f4e51b1d1e944ee39da92680e4bc5e98dd708f1457fcf612b`、`ac2494a3acc795c809c94ee9393f50271a9c2a0fd33813459e5ab93842ceef75`、`a37e0e9697144819e1d965176ac4ae5bc3fa02d11e7812036bbcadf6dafe2400`，与原 inventory 记录一致。作者、版权、revision、原文 hash、reviewRequired 和外部技能来源未改。

主控独立运行 dev-docs graph 测试 4/4 通过，日志 `output/zody-rename-validation/controller-r21-final-inputs-graph.log`；Terra 根 typecheck、lint 和本轮增量架构检查退出 0，lint303 warnings。全量架构仍有既有两项违规，增量通过不代表全量通过。图保留372个原始节点、726条边；既有失效 seed 未通过伪造等价或删边消除。

本批只修正生成输入，未重生 notices/inventory，未完成最终 R21 门禁。第三方生成需在后续固定候选隔离执行，保留现有许可待复核项。当前 Docker 导出仍在进行，未扩展安装或创建新的大型工作树。
