# 供裁决：修正 workspace 同名导致的第三方许可漏计

## 已确认的问题与范围

当前根 workspace 明确包含 `apps/zody-cli/packages/debug`，其真实包名是私有 `debug@0.1.0`。`scripts/third-party-npm.mjs:124` 的 `productionPackages(projects, isInstallable)` 用 project **名称**构造 `own`，把所有名称等于 `debug` 的依赖排除；`scripts/licenses.mjs:34,48–52` 的 basic 检查又用同样的名称过滤已安装包。因此真实生产图中的 npm `debug@4.4.3` 未进入 `required`、生成的 inventory 和 notices，也没有进入 basic 检查；已安装但当前 `--prod` 图未命中的 `debug@2.6.9` 同样被 basic 检查排除。当前 lockfile-only 与实际两种 pnpm 生产图各有 21 处 4.4.3 引用；详见 `output/zody-rename-r21/final-confirmation-ad859/` 下的 `debug-graph-readonly.json` 和 `debug-workspace-name-collision-audit.md`。这是许可证收集/检查缺陷，不要求修改应用运行时。

033f 已有同名 workspace、name-only 过滤和旧 inventory 的 debug 缺项；旧锁亦有 CLI→proxy-agent→debug@4.4.3 链。未在 033f 的独立安装上执行其完整生产图，故仅将已证实的机制及清单缺项归为基线事实，不宣称其全部历史运行状态。本问题与 ad859 reinstall 的 `-146` 物理变化没有已证实因果；后者的实际删除清单仍未知。

## 建议的最小产品规则

先更新或新建 `specs/third-party-license-identity.md`（现无专属许可证身份 spec），明确：workspace 身份由项目路径/真实链接目标确定，包名或 `name@version` 相等本身不证明身份；npm 包无论是否与 workspace 同名都要按生产/已安装规则审查。已有 lockfile、版本、integrity、peer、第三方作者及原文不变。不能确定一个 `link:` 的目标身份时 fail closed 并报告具体父项目/alias/目标，不静默当作 workspace 或第三方放过。

精确实现建议，均为**伪 diff，未应用**：

```diff
 scripts/third-party-npm.mjs
- export function productionPackages(projects, isInstallable = () => true) {
-   const own = new Set(projects.map((project) => project.name));
+ // workspace identity 从 projects 的绝对路径预先规范化；实际 symlink 使用 realpath。
+ export function productionPackages(projects, isInstallable = () => true, identity) {
    ...
-   if (!own.has(name) && !name.startsWith('@zody/') && !info.version.startsWith('link:'))
+   const kind = identity.classify({ parent, alias, info }); // workspace | third-party | unresolved
+   if (kind === 'unresolved') throw Error(包含 parent、alias、link 及路径的诊断);
+   if (kind === 'third-party')
      required.set(`${name}@${info.version}`, { name, version: info.version });
    // 即使节点是 workspace，仍向下遍历其生产 dependencies/optionalDependencies。
```

`readWorkspaceProductionGraph(root)` 在解析 `pnpm -r ls --prod --json --depth Infinity` 与其 `--lockfile-only` 版本后，为两图提供**同一** workspace 路径身份集合和分类规则，再交 `assertProductionGraphs` 比较。当前仓库的只读样本里两图的 `@zody/services → @zody/shared` 都提供 `version: link:../shared` 和指向 `packages/shared` 的 `path`。应以该路径对应真实 workspace 项目、并在需要时将 link 解析结果与 `pnpm-lock.yaml` 对应 importer/alias 交叉核对；workspace alias 按目标真实路径/显式 link 识别，alias 文本不必等于包名。`info.path` 对 hoisted 第三方可能是不存在的 `.pnpm` 路径，不能据此把外部包判为 workspace；lockfile-only 若缺少可验证路径，必须从对应 lock importer 的 link 和父节点上下文补证，仍无法证明就报未解析，不凭名称/版本猜。对于非 workspace 的本地 `link:`，不得因为有 `link:` 就排除；若当前生成器无法提供其精确版本与原文，应明确报待处理而非漏计。pnpm registry alias 的 `info.name ?? alias` 仍用于真实包名，独立于 workspace 身份判断。

```diff
 scripts/third-party-npm.mjs:191  scanInstalledPackages(root, projects)
+ const workspaceRealPaths = 由 project.path 对应真实目录构造的集合;
  async function scanPackage(directory) {
+   const actual = await realpath(directory); // 同一目录经 workspace symlink 只算一次
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
-   if (pkg.name && pkg.version) installed.set(`${pkg.name}@${pkg.version}`, { pkg, directory });
+   if (!workspaceRealPaths.has(actual) && pkg.name && pkg.version)
+     保留此第三方 name@version 与实际路径（同 key 多来源须可审计）;
+   // 跳过 workspace 本体时仍递归其 node_modules；不能漏其外部依赖。
  }
 scripts/licenses.mjs:34,48–52
- const ownNames = new Set(projects.map((project) => project.name));
- if (ownNames.has(pkg.name)) continue;
+ 使用上述已按路径识别的已安装第三方集合，不再按名称过滤。
```

`scanInstalledPackages()` 目前返回 `Map<name@version,{pkg,directory}>`，`missingProductionPackages()` 与 `collectNpmNotices()` 都消费该接口。实现时保持/明确这些调用者契约：先按真实路径剔除 workspace，再以精确第三方 name/version 与锁图匹配；多个第三方物理副本同名同版本不能由 workspace 占位覆盖，来源/许可原文不一致时应报出所有路径供审查，不能静默随机选一个。必要时提取 identity/collection 小函数供同一生成器和 checker 复用；不以“debug 特判”、重命名 workspace 或 `name+version` 碰巧不同作为身份规则。源码实现以实际 pnpm graph 结构为准，不能假定 workspace link 一定在所有模式都有相同的可 realpath 第三方路径。

## 先测试，再实现与验证

在既有 `scripts/test/third-party-npm-platform.test.mjs` 增加以下行为回归（原有平台/peer 筛选继续通过）：

1. 合成同一生产图：workspace `debug@0.1.0` 的路径/显式 `link:` 与 npm `debug@4.4.3` 同名共存；只排除经过目标路径证明的 workspace，保留 npm 4.4.3。对实际模式和 lockfile-only 两种图表示分别验证，`assertProductionGraphs` 不漏检、不误报。
2. workspace symlink 和不同 alias 均按同一真实目标识别；构造名字或版本恰好相同但路径为外部包的反例仍保留。无路径且没有可验证 importer link 的节点报明确错误，不按名称放行。平台排除与 peer suffix 测试继续覆盖。
3. 在临时目录建立 workspace `debug@0.1.0`、外部 `debug@4.4.3` 与 `debug@2.6.9` 的真实 package.json、LICENSE、workspace symlink 及各自 node_modules；`scanInstalledPackages`/共享 checker 身份过滤返回两个外部版本、不返回 workspace 本体，且 workspace 本体下外部嵌套依赖仍被遍历。加一条外部包与 workspace **同名同版本但不同真实路径**的反例，以防以版本代替身份；同 key 多物理副本材料不同应明确失败或审查。

在既有 `scripts/third-party-notices.test.mjs` 增加相同临时许可 fixture 的生成/核验集成场景：生产图中仅 4.4.3 时，inventory/notices 必须记录其精确版本、repository 和实装 LICENSE 原文字节 hash；2.6.9 仍参与 basic 已装许可检查，但不因 dev-only 而强加进生产 notices。验证 workspace 本体没有被错当第三方；不得用固定字符串假装读取原文。若现有生成入口难以注入假图，可提取最小依赖收集 seam 或使用隔离 fake pnpm graph，且不修改真实 HOME/network。先运行新增测试确认旧实现失败，再改实现、运行相同测试及现有 `node --test scripts/third-party-notices.test.mjs scripts/test/third-party-npm-platform.test.mjs`、实际 root typecheck/lint/changed architecture；锁文件和版本哈希核对后，在单独固定 clean 候选真实 frozen install 及许可 pair 原子生成/逐字段审阅。strict 19 项既有未决材料独立保留，不能为通过删除或伪造。

当前 1217 个生成 production package 中没有 debug；若修正后仅新增已证实生产依赖 `debug@4.4.3` 且没有发现其他同名/路径差异，预期可能变为 1218，但**这只是待实测推算**，须实际完整比较；baseline basic 检查的 2058 也可能因两个外部版本被纳入而变化。使用当前已装的 `debug@4.4.3` MIT、repository `git://github.com/debug-js/debug.git`、LICENSE SHA-256 `3a61c6c96caf5c1d9b623fb9b04c822b783dfcb78aa7e49c76a3f643e6ed7f95`；`debug@2.6.9` 实装 MIT、repository `git://github.com/visionmedia/debug.git`、LICENSE SHA-256 `98c970de440dcfc77471610aec2377c9d9b0db2b3be6d1add524a586e1d7f422`。原文、版本和来源应从实际安装与锁证据读取并核对，不能把 hash 本身当作授权或伪造作者。

建议用户裁决：是否按上述范围修正许可身份判断、先补行为回归并重新生成/审核 pair？本文件只是可审阅方案，未更改产品、生成器、许可材料或运行验证。
