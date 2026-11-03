# Independent SEA key closure source review

Route `deepseek-flash`, agent `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19ccf-8092-7d11-9010-8010e395f2a5`. Raw scoped receipt follows. Its pair-pending wording describes the source review scope; controller separately generated/audited/integrated matching pair at71e21e4f, with independent pair review pending.

**结论：scoped PASS**

在固定候选 `5bdc63fe…`（tree `eb34ddac…`）中，五组 SEA 内部资产前缀的生产端与消费端、根许可索引、显式测试入口和现行说明彼此一致，并且没有把这次内部前缀改动扩散到外部身份或持久数据。未发现需要阻断本批源码验收的问题；但本结论不等于真实 SEA 构建或发行验证通过。

**已核对**
- 18 个源码/spec/doc 文件的 before/after SHA 与 `file-hashes.json` 一致，第 19 个 Desktop 文件只有两处注释 token 变化；`git diff --check` 通过。
- 五组生产端与消费端逐组对应：
  - TUI：`sea-tui-assets.mjs:12` ↔ `tui-runtime-loader.ts:30`
  - Playwright：`sea-playwright-assets.mjs:7` ↔ `sea-playwright-runtime.ts:27`
  - Runtime tools：`sea-runtime-tool-assets.mjs:11` ↔ `sea-runtime-tools.ts:47`
  - Bundled skills：`sea-bundled-skill-assets.mjs:9` ↔ `bundled-skills.ts:51`
  - Official plugins：`sea-official-plugin-assets.mjs:6` ↔ `bundled-plugins.ts:40`
- 根分发脚本直接读取的两个许可 key 已同步（`scripts/build-zody.mjs:194`、`:197`）；运行时工具 manifest 仍只存 tool 元数据，由消费端用统一前缀构造 key。
- 未发现旧资产 key 的源码消费者；旧前缀只保留在历史调查/旧设计文档、contract-map 的 old→new 说明和测试临时目录名中。
- `sea-key-closure.test.mjs` 最终版直接传 `result.assets`，严格 key 查找会在缺失时抛错；先删 manifest 验证 fallback 不能把错配掩盖成成功，再恢复 manifest 验证文件/materials 落地和二次运行复用。`red.log` 的 5 个失败均由旧 key 缺失触发，`green-direct.log` 为 5/5。
- 身份边界未混改：`zcode-plugins-official` marketplace、`zcode-guide` 插件名、`.zcode-plugin` 目录、第三方文件字节及 `zody-provider/zody-builtin.json` 均保持原值。
- `packages/desktop/electron-builder.config.js` 仅修正当前包名注释；历史 `tsup.config.ts` 注释保留，符合范围说明。
- controller 证据 `sea-key-controller/results.json` 记录 closure 5/5、distribution 11/11、typecheck/lint/changed architecture/diff 均 exit 0；CLI 包测试日志包含新增回归且 515/515 通过。

**证据限制**
- 未执行真实 SEA 二进制构建、注入或 smoke；TUI/Playwright collector 测试使用已有 dist，不能证明干净构建产物。
- 未执行根 `build-zody` 的实际发行阶段；`distribution-tests` 只是测试。
- CLI `package.json` 的测试 argv 已变，workspace inventory 配对需由 R10 从固定候选重新生成；本批不据此判最终 release。
- `strict 19`、最终发行及完整 R22 不在本结论内。

**非阻断观察**
- `tests/sea-key-closure.test.mjs:60` 比较旧/新 `createRequire` 合成文件名，但两者位于同一目录，解析结果天然相同；该断言不证明实现使用新文件名，源码 diff 已直接证明。报告已限定该测试性质。
- 插件缓存复用用 inode 断言；在 Windows 上 inode 可能为 0，原地重写也可能保持 inode，不能算强复用证明。报告已避免“全局零读取”声明。
- `docs/dynamic-workflow/authoring.md:602` 仍写 `~/.zcode/cli/bundled-skills/<hash>/`，而当前 README/默认存储为 `~/.zody`；这是既有文档残留，不是本批前缀改动引入，建议后续文档批次顺手修正。
