# R21 graph 旧预检事实分诊

固定 `b867ad3d359d3219b0a111c8e9b2911ea172b096`，对旧预检 68 个缺失路径及 18 个 symbol 文本 miss 的逐项只读分类见 `output/zody-rename-r21/graph-semantic-disposition/rows.json` 与 `report.md`；这是有限集合审计，不是全图语义验收。

68 条路径中：1 条 `packages/ui/src/app-shell/useAppPanels.ts` 为已确认的过期图引用，现行源码为 `packages/ui/src/hooks/useAppPanels.ts`；祖先 `033f91783901e6adaf968d3d4b8ca34c41d89442` 的图已含该旧路径，彼时实际文件已在 hooks，因此先于本次改名。51 条对应明确删除或回滚范围，15 条尚待逐项核实，1 条仓外 CUA sibling 归属待确认。历史删除并不授权恢复功能或为检查变绿而删除图节点/边。

18 条旧 symbol miss 中，1 条在 b867 已更新为 `ZodyProtocolAgentDependencies`，5 条是类方法 dotted 字符串扫描误报，2 条有同名位置但语义等价待核实，2 条属明确删除的 off-peak/会话分享，8 条仍未决。未决项不得按文本相似直接替换，也不能据此声称图语义全部闭合。

## 033f 祖先补充归因

对上述仍需判断的 15 个仓内 missing path、8 个未决 symbol、2 个同名待证 symbol，按旧图同 node、原目录映射和源文件/精确 symbol 检查，25 项的 seed 失配已在 `033f91783901e6adaf968d3d4b8ca34c41d89442` 存在，因此属于本次 rename 之前的基线；这不是业务语义等价证明。另 1 个 `../zcode-cua/...` 仓外 sibling 在祖先图已出现，但本仓 Git 无法证明外部仓的实际存在，仍待 CUA/R60 核验。该 26 项没有确认由 rename 新引入的失配；范围不涵盖其他 graph 条目。逐条证据、映射与祖先删除历史在 `output/zody-rename-r21/graph-semantic-disposition/supplemental-033f.json` 和 `supplemental-033f.md`。未更改 graph/产品，也未执行 build/install。
