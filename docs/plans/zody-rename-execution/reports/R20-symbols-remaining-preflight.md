# R20.4 剩余符号只读预检

基线为固定 Git commit `e79eab7d`，从该提交隔离提取原候选对应的 221 个源码文件到 `output/zody-rename-r20-symbols/remaining-plan/snapshot/`；未读取并发移动中的源码树来声称引用闭合。未修改产品源码或构建产物，未运行测试。

原 1,602 条候选均在 `e79-classification.json` 逐条保留：1,581 条在相应基线文件仍有同名 TS 声明，21 条无同名声明（为前批已改名项，须保留记录）；只在这 221 个文件发现声明，不代表全仓候选扫描完备。这是 AST 声明分类，不是绑定或调用者验证。

`batch-groups.json` 按依赖边界列出候选文件与符号，供单一写者在 R10 停止后重新绑定：

- A0 ProcessManager 17 个声明，包括 NativeRuntimeResolver/Context、runtime lifecycle 类型、resolve/validate/wrap 及局部 spawn helper。`process-manager-evidence.json` 列固定基线 129 个词法命中、18 个文件及行号：services/node、storage-startup、Desktop host、Server 测试和相关 mock 等。它们不是完整引用证明；测试中模块 mock 的导出键和 namespace 调用需随内部 API 调整，普通外部对象键不应盲改。
- B0 shared task、agent/session：525 个候选，先按 shared 声明→services/session owner→CLI/Host/UI 消费者拆可审查的串行 binding 集合；现有 task/projection 字段与持久键不随 TS 绑定自动变化。
- C0 shared/bootstrap 协议相关：613 个候选，shared protocol 大文件与 bootstrap 副本需按实际公共导出、类型依赖成组；仅内部 TS 绑定归 R20，wire discriminator、序列化字段/方法及版本门禁归 R40–R43，不能靠词法替换。
- D0 CLI runtime 113、E0 UI 120、F0 Desktop 64、G0 provider 37、H0 services/server 等 92；各组具体路径和声明列表见 JSON。内部 binding 属 R20；遥测值 R46、builtin 运行时/持久属性 R44、插件旧 alias R50–R55、hook 来源 R47、env/define R30 不被内部类型改名隐含授权。纯内部对象属性不应一律归后续：先追声明、调用者、对象构造、mock 和序列化边界再单独确定。

这些是组织依赖的静态草案，不是可直接执行的 patch 或写入授权。R10 完成并冻结实际候选后，主控先用最终 basename 映射重算所有路径和大小写碰撞；对每组以 TypeScript 语言服务重绑定，覆盖根与 CLI 子包、re-export、测试、mock、生成 d.ts/JS 和动态路径；manualReviewPaths、外部插件模板和历史/冻结证据保持原边界。发生共享声明/消费者交叉时同批串行，不把同一公共符号按目录拆给多个写者。随后从源码重建真实 dist，运行根/CLI 相关类型检查和实际目标测试；任一缺失的动态或生成调用者明确列为未闭合。`batch-groups.json` 中的文件与名字只作为新一轮固定候选的种子。
