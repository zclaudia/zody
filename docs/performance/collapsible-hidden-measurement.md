# 隐藏折叠内容跳过几何测量（Radix Collapsible）

## 状态与范围

- 计划项：`docs/plans/upstream-v3.16.2-implementation-plan.md` I10 / port-plan UP316-I10。
- 本文只定义该补丁的差异规则：**Radix `CollapsibleContent` 在节点隐藏（`hidden`）时不得读取几何**。
  Radix 既有的 presence、动画变量与 `forceMount` 语义不在此重复定义，按上游实现保留。
- 代码落点：
  - 适配层：`packages/ui/src/components/ui/collapsible.tsx:14-48`（只负责样式与 `data-slot`，不承载测量逻辑）。
  - 使用方：`packages/ui/src/ToolCallBlocks/ToolLayout.tsx:347-352`（每个可折叠工具卡片都会挂载一个 `CollapsibleContent`），
    以及 `:19` / `:195-210` 的 300ms 延迟卸载（依赖 Radix 的高度变量，本项不改）。
  - 测量实现（上游基线，打补丁后行号顺移）：`node_modules/@radix-ui/react-collapsible/dist/index.mjs:103-126`（ESM）与
    `node_modules/@radix-ui/react-collapsible/dist/index.js:144-167`（CJS），几何读取分别在 `:116` / `:157`。

## 问题（现状证据）

`CollapsibleContentImpl` 的 `useLayoutEffect`（依赖 `[context.open, present]`）在 `node` 存在时**无条件**调用
`node.getBoundingClientRect()`，随后把 `rect.height/width` 写入 `heightRef/widthRef`。

Radix `Presence` 对 `CollapsibleContent` 始终传入 render function（`children` 是函数，走 `forceMount` 分支），
因此即使折叠，`CollapsibleContentImpl` 仍会挂载一个 `hidden` 的 div；首次挂载、开合与 presence 变化都会读一次几何。
`ToolLayout` 对每张可折叠工具卡片都渲染 `CollapsibleContent`（包括全部收起的历史卡片），
于是「批量 hidden 工具卡片」在一次提交内产生与卡片数同阶的强制布局读取。

## 补丁合同

唯一 owner：`@radix-ui/react-collapsible` 的 dist 补丁（`patchedDependencies` 登记）。适配层与 `ToolLayout` 不新增测量兜底。

必须满足：

1. **隐藏不读几何**：`node.hidden === true` 时不得调用 `getBoundingClientRect()`（以及等价的
   `getClientRects()` / `offsetHeight` / `offsetWidth` 等布局读取）。
2. **可见照常测量**：`open` / `defaultOpen` / 可见的退出动画帧 / `forceMount` 内容仍按 Radix 原逻辑测量，
   并把结果写入 `--radix-collapsible-content-height` / `--radix-collapsible-content-width`。
3. **presence 语义不变**：跳过测量不得跳过 `setIsPresent(present)`；挂载/卸载、`data-state`、`hidden` 的取值与上游一致。
4. **保留最近一次可见尺寸**：隐藏帧不重新测量，`heightRef/widthRef` 保留最近一次可见测量值，
   供 `animate-collapsible-up` 等退出动画继续读取。
5. **样式保存/恢复不变**：`transitionDuration` / `animationName` 的保存与恢复逻辑保持上游行为。

建议的最小差异：在既有 `if (node)` 块内，仅当 `!node.hidden` 时执行几何读取及由 `rect` 派生的 refs 写入，
其余（`originalStylesRef`、样式恢复、`setIsPresent`）保持原顺序。

## 补丁目标与双格式

- 本项落在 `patches/@radix-ui__react-collapsible@1.1.12.patch`，并在根 `package.json` 的
  `patchedDependencies` 以精确版本登记；其他包的既有补丁不受本项影响。
- 实际承载测量代码的包是 `@radix-ui/react-collapsible@1.1.12`。`radix-ui@1.4.3` 只是聚合入口：
  `node_modules/radix-ui/dist/index.mjs` 仅 `import * as Collapsible from "@radix-ui/react-collapsible"` 并 re-export，
  对 `radix-ui` 本身打补丁不会改变折叠测量实现。`pnpm patch` 必须指向 `@radix-ui/react-collapsible@1.1.12`。
- 该包同时发布 CJS 与 ESM：`dist/index.js`（`main`）与 `dist/index.mjs`（`module` / `import`）。
  补丁必须同时覆盖两份产物；只改 ESM 时，走 `require` 的构建/工具链仍会测量隐藏节点。
  `.d.ts` / `.d.mts` 不含实现，无需改动。
- `@radix-ui/react-accordion` 的 `AccordionContent` 直接复用 `CollapsiblePrimitive.Content`
  （`node_modules/@radix-ui/react-accordion/dist/index.mjs:281-291`），因此 Accordion 同样继承
  「hidden 节点不读几何」，不为它另打补丁；回归用例见 `packages/ui/test/accordion.test.ts`。
- `patchedDependencies` 以精确版本登记（例如
  `"@radix-ui/react-collapsible@1.1.12": "patches/@radix-ui__react-collapsible@1.1.12.patch"`），并同步
  `pnpm-lock.yaml` 的 `patchedDependencies` 与 patched package 快照。

## 版本锁定原因

- `packages/ui/package.json` 使用 `"radix-ui": "^1.4.3"`；`radix-ui@1.4.3` 以精确版本依赖
  `"@radix-ui/react-collapsible": "1.1.12"`（`node_modules/radix-ui/package.json`），锁文件当前解析为
  `radix-ui@1.4.3` + `@radix-ui/react-collapsible@1.1.12`（见 `pnpm-lock.yaml` 中两者的 importer / snapshot 条目）。
- 升级 `radix-ui`（包括 patch/minor）会重新解析其子依赖，`@radix-ui/react-collapsible` 版本一旦变化，
  按版本登记的补丁不再匹配，**测量补丁会被静默丢弃**。因此：
  1. 任何 Radix 升级必须重做补丁、重算 `patchedDependencies` 的 hash，并重跑本项反例测试；
  2. `pnpm install --frozen-lockfile` 必须可重复安装且补丁处于 applied 状态；
  3. 不得用适配层包装、`memo` 或业务侧缓存替代该补丁来「绕过」升级后的丢失。
- 反例测试同时是补丁存在性守卫：补丁丢失时隐藏节点会重新出现几何读取，测试变红。

## 验收场景

| 场景                                               | 期望                                                                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 批量收起（hidden）的 `ToolLayout`                  | 每个 `[data-slot="collapsible-content"]` 仍是 `hidden`；隐藏节点上的 `getBoundingClientRect` 调用数为 0                                                                                       |
| 批量收起后展开其中一张、再次收起                   | 只有被展开的可见卡片被测量；其余隐藏卡片 0 读取；再次收起后该卡片恢复 0 读取并保留最近可见尺寸                                                                                                |
| 收起状态的 `CollapsibleContent`（未 `forceMount`） | DOM 中存在 hidden 节点，但挂载后不读几何                                                                                                                                                      |
| `defaultOpen` / 点击展开                           | 可见节点被测量，CSS 变量得到测量的宽高                                                                                                                                                        |
| 收起（从展开到关闭）                               | 可见帧可测量；进入 hidden 后不再补测，CSS 高度变量保留最近一次可见值（该用例不单独证明 guard：`useLayoutEffect` 在 `present=false` 时不重跑；guard 由初始 hidden、批量与 Accordion 用例证明） |
| `forceMount` 且 `open=false`                       | 按 Radix 语义保持可见（不是 hidden），仍被测量                                                                                                                                                |
| Accordion 收起项 / 展开项                          | 收起项 hidden 不读几何；展开项正常测量并继承 `--radix-collapsible-content-height`                                                                                                             |
| Accordion 从展开项切到另一项                       | 新展开项被测量；旧展开项转入 hidden 后 0 读取并保留最近可见尺寸；高度动画类名不回归                                                                                                           |
| 既有动画/间距回归                                  | `collapsible.test.ts` / `toolLayout.test.ts` 原有静态标记断言全部保持                                                                                                                         |

## 验证

```bash
pnpm exec vitest run packages/ui/test/collapsible.test.ts packages/ui/test/toolLayout.test.ts packages/ui/test/accordion.test.ts
```

- 反例测试用 jsdom 夹具记录 `getBoundingClientRect` 的调用元素与返回几何；隐藏节点按真实排版返回 0×0。
  夹具同时对契约第 1 条的等价布局读取（`getClientRects()` / `offsetWidth` / `offsetHeight`）计数，
  隐藏节点上的四类读取都必须为 0——补丁只改 `getBoundingClientRect` 一处，但反例覆盖整条「隐藏不读几何」合同。
  可见节点上另有显式正对照（`readEquivalentGeometry` / `expectProbeRecordsEquivalentReads`），
  证明 `getClientRects` / `offsetWidth` / `offsetHeight` 的 0 记录不是「本来就没调用」的空断言。
  它验证「是否读取」与「隐藏后保留的最近可见尺寸」，不是浏览器像素布局验收。
- `collapsible.test.ts` 直接校验安装产物的 CJS（`dist/index.js`）与 ESM（`dist/index.mjs`）都保留
  `if (!node.hidden)` guard；组件测试只走 ESM 解析，不能覆盖 CJS 产物。
- 补丁落地后需执行一次 `pnpm install`（或 `pnpm install --frozen-lockfile`）确认 `patchedDependencies` 生效，
  并重跑上述命令。

### 落地记录（2026-10-24）

| 命令                                                                                                                                         | 结果                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm exec vitest run packages/ui/test/collapsible.test.ts packages/ui/test/toolLayout.test.ts`（补丁前基线）                                | 4 failed / 11 passed；hidden 节点读取 30/1 次                                                          |
| `pnpm exec vitest run packages/ui/test/collapsible.test.ts packages/ui/test/toolLayout.test.ts packages/ui/test/accordion.test.ts`（补丁后） | 3 files / 18 tests passed                                                                              |
| 临时移除两份 dist 的 guard 后重跑同一命令                                                                                                    | 7 failed / 11 passed（含 CJS/ESM 产物守卫与 Accordion 用例），恢复后 18/18 通过                        |
| `pnpm install`（连续两次）                                                                                                                   | exit 0；安装产物两份 dist 均含 guard                                                                   |
| `pnpm install --frozen-lockfile`                                                                                                             | exit 0；锁文件与 `patchedDependencies` hash 一致                                                       |
| `node scripts/licenses.mjs check`                                                                                                            | 在手机远控未提交的 `apps/zcode-cli/packages/bootstrap/package.json` 输入失配处中止（本项未改动该文件） |

- 真实浏览器 layout/性能指标尚未执行：卡片声明的「浏览器夹具 + layout 指标」当前以 jsdom 调用计数夹具替代，
  偏差记录在实施计划 I10 卡与审查台账，待后续浏览器 E2E 补齐；本项不声称已交付该证据类型。
  现有反例只证明「hidden 不读几何」，不提供帧耗时数据。

### 续作记录（2026-10-24，复位复审）

| 变更                                                                                                                          | 结果                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 夹具从只记录 `getBoundingClientRect` 扩展到 `getClientRects` / `offsetWidth` / `offsetHeight`（contract 第 1 条等价布局读取） | 隐藏节点四类读取均为 0                                                                                                |
| 新增批量 `ToolLayout` 正对照：30 张收起卡片中展开一张、再收起                                                                 | 仅可见卡片被测量；其余隐藏卡片 0 读取；收起后该卡片 0 读取并保留最近可见尺寸                                          |
| 新增 Accordion 展开项切换与高度动画类名回归                                                                                   | 新展开项测量、旧展开项 hidden 后 0 读取；`data-open:animate-accordion-down` / `data-closed:animate-accordion-up` 保持 |
| `pnpm exec vitest run packages/ui/test/collapsible.test.ts packages/ui/test/toolLayout.test.ts`（含新增用例，补丁在位）       | 2 files / 18 tests passed（见本节「验证」口径；新增断言在移除 guard 的变异下变红）                                    |

- 本节新增断言是补丁存在性守卫：临时移除两份 dist 的 `if (!node.hidden)` guard 后，本命令 9 failed / 12 passed
  （三个测试文件合计；含新增的等价读取、批量正对照与 Accordion 切换用例），恢复补丁后 3 files / 21 tests passed。
  夹具仍不代表真实浏览器排版耗时。
- `node scripts/licenses.mjs check` 本轮无法跑完：工作区中另有未提交的
  `apps/zcode-cli/packages/bootstrap/package.json`（非本项改动）使清单输入失配并在该文件处中止。
  I10 自身的登记已逐项核对：`THIRD-PARTY-NOTICES.md` 的 `noticesSha256`、`package.json` 输入哈希与
  `patches/@radix-ui__react-collapsible@1.1.12.patch` 的输入/`patches` 条目均一致。

### 交付复验（2026-10-24，B3 复审续作）

本轮在遗留改动基础上只做复验与登记修正，不重写补丁/测试：

- `pnpm exec vitest run packages/ui/test/collapsible.test.ts packages/ui/test/toolLayout.test.ts`
  → 2 files / 18 tests passed。
- `pnpm exec vitest run packages/ui/test/collapsible.test.ts packages/ui/test/toolLayout.test.ts packages/ui/test/accordion.test.ts`
  → 3 files / 21 tests passed。
- `pnpm --dir packages/ui exec vitest run test/collapsible.test.ts test/toolLayout.test.ts test/accordion.test.ts`
  → 3 files / 21 tests passed。CJS/ESM 产物守卫改为 `createRequire(import.meta.url)` 解析安装产物，
  不再依赖仓库根 cwd（此前包级 cwd 下 `process.cwd()` 会拼出不存在的路径）。
- 三个测试文件都新增可见节点正对照：显式调用 `getClientRects` / `offsetWidth` / `offsetHeight`，
  证明隐藏节点上这三类读取的 0 记录不是「本来就没调用」的空断言。
- `pnpm install` 连续两次 → 均 exit 0；`pnpm-lock.yaml`、`package.json`、`THIRD-PARTY-NOTICES.md`、
  `third-party/inventory.json` 的 sha256 在安装前后不变，两份 dist 的 `if (!node.hidden)` guard 保持在位。
- 删除 `node_modules/@radix-ui/react-collapsible` 后执行 `pnpm install` → exit 0；恢复出的目录与删除前
  `diff -r` 逐字节一致（两份 dist 均含 guard），证明补丁可从零应用而非仅沿用旧产物。
- `pnpm install --frozen-lockfile` → exit 0；锁文件 `patchedDependencies` 的 hash
  `f10c389f…` 与 `patches/@radix-ui__react-collapsible@1.1.12.patch` 的 sha256、`third-party/inventory.json`
  的 `patches[].sha256` 一致。
- 临时把两份 dist 的 `if (!node.hidden)` 改为 `if (true)` 后重跑三文件命令 → 9 failed / 12 passed；
  从备份恢复后 21/21 通过，说明新增断言不是空过。
- `node scripts/licenses.mjs check` → exit 1，在未提交的
  `apps/zcode-cli/packages/bootstrap/package.json` 处中止（手机远控工作线文件，本项不修改）；
  逐项核对 3080 个输入共 2 个失配（上述 bootstrap 与 `packages/services/package.json`），本项自身登记一致。
- `third-party/inventory.json` 由 `node scripts/licenses.mjs notices` 全量重算，除 I10 必需的
  `package.json`、`pnpm-lock.yaml`、patch 与 notices 条目外，还刷新了 15 个与本项无关、但当前内容等于 HEAD 的
  陈旧输入哈希（12 个 plugin `package.json`、`packages/desktop/package.json`、`ZCodeAboutLogo.tsx`、
  `builtinSkillI18n.ts`）。这是账目校准而非手机远控未提交内容；拆分会破坏生成文件与工作区的一致性，
  故随本项一并登记。
- 环境备注：本轮命令在 Node v22.23.2 下执行（`mise.toml` 钉 24.14.0，当前 shell 无 `mise`），
  `pnpm install` 有 engine 警告但 exit 0。

## 非目标

- 不改变 `ToolLayout` 的 300ms 延迟卸载、动画时长、层级或视觉表现。
- 不为其他 Radix 组件另打同类补丁（Accordion 等通过共享的 Collapsible 包继承该行为）；不做通用 Radix 性能改造。
- 不新增业务侧测量缓存或第二套尺寸事实。
