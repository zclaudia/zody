# MiMo v2.6 与 API / Token Plan 模板

状态：已实施（上游 v3.16.2 · I17），2026-10-24。
上游来源：`zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab` 的
`config/provider/zody-builtin.json`（`xiaomi-mimo` / `xiaomi-mimo-token-plan`，revision 33）。
决策口径：[实施计划 I17 行](plans/upstream-v3.16.2-implementation-plan.md:62)：模板增量新增 v2.6
与 API / Token Plan 端点；实施时核验厂商状态，若 v2.5 已停服先回报再定；Personal 配置一律不静默改写。
**该例外分支已于实施时触发**：厂商确认 v2.5 下线，owner 裁决移除模板中的 v2.5 成员（见 §1）。

本文只补 MiMo 模板拆分与 v2.6 条目的差异。Provider Template Schema、Built-in/Personal
overlay、Registry 装配、双环境打包与 revision 规则沿用现有实现与文档，不在此重复：

- 配置组合与 Personal 优先于模板：`packages/provider/src/resolver.ts:199-209`
  （`templatePersonalProviders`，`template.overlay(personal)`）与
  `packages/provider/src/config/model-config.ts:387-423`
  （按规则顺序 overlay，后命中覆盖前命中）。
- Built-in 生产源、测试源同步与 revision 跟随：
  [Built-in Provider 配置双环境打包](./builtin-provider-config-build-environments.md)。
- 模型事实与 Template 身份的通用约束：
  `packages/provider/test/provider-template.test.ts:20-60`。

## 1. 决策记录与厂商核验

决策（2026-10-24，独立复审回报后 owner 裁决，触发计划 §3 I17 的停服例外分支）：

- `xiaomi-mimo` 的 `builtinModelIds` 与 `templateModelRules` 收敛为 v2.6 两项；
  `xiaomi-mimo-token-plan` 同样只声明 v2.6。
- 厂商下线是外部事实：**不迁移、不改名、不删除、不写回**任何 Personal 配置、历史
  `defaultModelSelection` 或 ModelSelection；旧 v2.5 Personal 实例保持原样，不弹迁移提示。
- 保留既有 v2.5 `modelRules` / `modelApiRules`，供存量 Personal 模型继续解析能力；它们不再属于
  模板成员，也不因厂商停服被改成 v2.6。
- 不引入新的 Provider 类型或 Access 类型。

厂商事实（2026-10-24 实际抓取，非推测）：

| 事实                      | 结论                                                                                                                                                                    | 来源                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| v2.6 模型 ID              | `mimo-v2.6-pro`、`mimo-v2.6-flash`（另有 `mimo-v2.6-pro-ultraspeed`，2026-09-22 发布）                                                                                  | MiMo 模型更新日志 `docs/zh-CN/updates/model`                                                        |
| v2.5 状态                 | 2026-10-14 18:00 起 `MiMo-V2.5-Pro`/`MiMo-V2.5` 请求自动转发至 V2.6；**2026-10-21 10:00（UTC+8）正式下线，原模型名称失效**                                              | MiMo v2.6 公告 `docs/zh-CN/news/latest/v2-6`；按量计费页 `docs/zh-CN/price/pay-as-you-go`           |
| 按量 API Anthropic 端点   | `https://api.xiaomimimo.com/anthropic`                                                                                                                                  | Token Plan Claude Code 接入页 `docs/zh-CN/tokenplan/integration/claudecode`（“按量付费 API”段）     |
| Token Plan Anthropic 端点 | 中国 `https://token-plan-cn.xiaomimimo.com/anthropic`；新加坡 `https://token-plan-sgp.xiaomimimo.com/anthropic`；欧洲 `https://token-plan-ams.xiaomimimo.com/anthropic` | `docs/zh-CN/tokenplan/Token Plan/quick-access`                                                      |
| Key 身份                  | 按量 Key `sk-…`；Token Plan Key `tp-…` / `ttp-…`；两者相互独立、不可混用                                                                                                | `docs/zh-CN/tokenplan/Token Plan/quick-access`                                                      |
| v2.6 `[1m]` 标记          | Claude Code 接入页支持 `mimo-v2.6-pro[1m]` / `mimo-v2.6-flash[1m]`，用于显式选择 1M 上下文变体；裸 ID 的 1M 仍为上游 Built-in 声明值，未独立核验                        | Token Plan Claude Code 接入页 `docs/zh-CN/tokenplan/integration/claudecode`（复审 2026-10-24 核对） |
| v2.6 推理参数             | 官方页面未给出可引用的上下文/输出/模态/思考参数表；本文采用上游 Built-in 声明值（见 §3），真实请求未验证                                                                | 上游 `zody-builtin.json`；标注为待核验                                                             |

`mimo-v2.6-pro-ultraspeed` 不进入模板成员，也不命中 v2.6 规则：上游模板未纳入，套餐权益与推理参数
未核验；v2.6 规则使用精确模型名（见 §3），该型号由通用兜底解析（200K 上下文、32K 输出、无多模态），
需要时由用户作为个人模型追加，不凭名称猜测能力。`mimo-v2.6-pro-ultraspeed[1m]` 的上下文窗口由既有
通用 `.*\[1m\]` 规则提升为 1M，但这不属于 v2.6 能力继承，多模态、输出上限与 Map 仍走通用兜底。

## 2. 模板契约

两个模板是独立身份，不共享端点或成员继承；`templateId` 是身份 key，不能按显示名、URL 或 Key 前缀推断。

| templateId               | 显示名（zh-CN / en-US）                             | access                                        | api type             | baseUrl                                          | builtinModelIds（顺序即默认展示顺序） |
| ------------------------ | --------------------------------------------------- | --------------------------------------------- | -------------------- | ------------------------------------------------ | ------------------------------------- |
| `xiaomi-mimo`            | `Xiaomi MiMo API` / `Xiaomi MiMo API`               | `api-key`，`https://platform.xiaomimimo.com/` | `anthropic-messages` | `https://api.xiaomimimo.com/anthropic`           | `mimo-v2.6-pro`、`mimo-v2.6-flash`    |
| `xiaomi-mimo-token-plan` | `Xiaomi MiMo Token Plan` / `Xiaomi MiMo Token Plan` | `api-key`，`https://platform.xiaomimimo.com/` | `anthropic-messages` | `https://token-plan-cn.xiaomimimo.com/anthropic` | `mimo-v2.6-pro`、`mimo-v2.6-flash`    |

规则：

- `xiaomi-mimo` 由现有模板改名（`Xiaomi MiMo` → `Xiaomi MiMo API`）并收敛为 v2.6 成员；不改其
  Provider 模板身份、Access 类型、Key 管理页或 logo key。
- `xiaomi-mimo-token-plan` 是新增模板，只声明 v2.6 成员；不得把 v2.5 或 API 端点带进该模板，也不得
  把 Token Plan 端点带进按量模板。
- 两个模板的 `baseUrl` 必须不同；不得用同一模板加“套餐开关”表达两种凭证，也不得按 Key 前缀路由。
- Token Plan 的海外地域通过 Personal `api.baseUrl` 覆盖为 SGP / AMS 端点；模板默认只声明 CN，
  不做自动地域切换，也不把覆盖值归一化回 CN。
- 共用 `logo.key: xiaomi-mimo` 只表达厂商视觉身份，不表达端点或套餐。

## 3. 模型规则

新增内容与 Upstream 对齐，但不迁移整份上游模型目录，也不改动既有 v2.5 / v2 系列规则：

| 规则层               | 匹配                                                                     | 配置                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelRules`         | v2.6 `pro` / `flash`（允许裸名、`/` 前缀与 `[1m]` 标记，模型名尾缀精确） | `contextWindow: 1000000`；`inputFormat` 图片/视频/音频为 true，PDF 沿用兜底 false；`reasoningLevel.values: [disabled, enabled]`；`maxOutputTokens.max: 131072` |
| `modelApiRules`      | 同上 + `anthropic-messages`                                              | `thinking.type = enabled / disabled`（`reasoningLevel == "enabled"`）                                                                                          |
| `templateModelRules` | 两模板的 `mimo-v2.6-pro` / `mimo-v2.6-flash`                             | `enabled: true`                                                                                                                                                |

规则互斥要求：

- v2.6 规则不得命中 v2.5 家族，v2.5 规则也不得命中 v2.6 家族。可观察差异：`mimo-v2.5-pro`
  必须保持文本模型（图片/视频/音频均为 false），不能继承 v2.6 的全模态声明。
- v2.6 规则必须命中带厂商或网关前缀的透传 ID（如 `vendor/mimo-v2.6-pro`、
  `gateway/vendor/mimo-v2.6-pro`）以及厂商接入页支持的 `[1m]` 标记（`mimo-v2.6-pro[1m]`、
  `vendor/mimo-v2.6-flash[1m]`），但不得放宽尾缀。本仓 `matchesRule` 以 `^(?:pattern)$` 锚定，
  规则写成 `(?:.*/)?mimo-v2\.6-(?:pro|flash)(?:\[1m\])?`：前缀只能是空（裸名）或止于 `/` 的路径，
  尾部只允许可选的 `[1m]`。外层已锚定时 `(^|/)` 无法跨过前缀，`(?:.*/)?` 是同一「起点或 `/`
  边界」语义的可执行写法；不要退回裸 `mimo-v2\.6-(?:pro|flash)`（会漏掉聚合/网关透传 ID），
  也不要加宽尾缀。`[1m]` 只是同一型号的 1M 上下文标记，能力必须与裸 ID 完全一致。
  上游的 `.*mimo-v2\.6-(?:pro|flash).*` 会连带命中独立的 `mimo-v2.6-pro-ultraspeed`，
  尾缀通配是唯一有意偏离上游的部分。`packages/provider-node/test/zcode-builtin-integrity.test.ts`
  对两个模板身份都有裸 ultraspeed 反例，并补聚合/网关透传的带前缀 v2.6、带前缀 `[1m]` 变体、
  带前缀 ultraspeed 与无 `/` 边界近似名反例：v2.6 命中 1M / 131072 / 多模态，
  ultraspeed 与近似名落 200K / 32K / 无多模态兜底。
- 不新增 v2.6 的 `openai-chat-completions` 映射：两个模板都是 `anthropic-messages`；用户把
  Personal 实例改成其他协议时沿用现有通用兜底，不凭空声明未核验的映射。
- 保留 `mimo-v2.5` 的图文音能力、1M 上下文与 131072 输出上限，以及 `mimo-v2.5-pro` 的文本能力；
  它们只服务存量 Personal 模型，不再出现在模板成员中。
- Upstream v3.16.2 的 v2.5 匹配使用更松的正则（`.*mimo-v2\.5.*`），当前仓库使用精确分隔符
  写法；本轮只补 v2.6 差异，不改写既有 v2.5 规则形态，也不以正则等价性代替行为断言。
- revision 递增（32 → 33），并按双环境规则同步 `config/provider/zody-builtin.test.json`。

## 4. Personal 与历史配置

模板更新只影响“未由 Personal 声明的字段”；Personal 已声明字段一律优先，且不得写回：

| 字段                                          | 模板更新后的行为                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| `providerName`                                | 保留用户名称；模板改名不覆盖 Personal 名称                                      |
| `access.apiKey` / `apiKeyManagementUrl`       | 保留；模板不携带 Key，也不改写 Key 管理页                                       |
| `api.type` / `api.baseUrl`                    | 保留；SGP / AMS 等覆盖 URL 不被重置为模板默认                                   |
| `enabled`                                     | 保留；`false` 不因模板变化而恢复启用，也不进入 Registry                         |
| `personalModelIds` / `modelOrder`             | 保留；模板成员变化只改变派生视图，不回写 Personal 文件                          |
| `defaultModelSelection` / 历史 ModelSelection | 原样往返；旧 v2.5 选择即使厂商下线也不静默替换为 v2.6，按现有不可用错误路径提示 |

模板成员缩减的行为：已有 `templateId: xiaomi-mimo` 且 `personalModelIds` 含 v2.5 的 Personal 实例，
仍会在设置页/Registry 看到该模型（`source: "personal"`），因为它是用户显式保存的成员；模板移除
v2.5 不得反向删除用户 Personal 中已保存的模型或覆盖用户禁用态。模型能力继续由保留的 v2.5 规则解析；
厂商端点失效属于外部事实，本仓不代为迁移、清理或弹提示。

## 5. 状态所有者与组合顺序

```text
config/provider/zody-builtin.json（唯一编辑源，revision 32 → 33）
  ├─ providerConfigRules.templateRules
  │    ├─ xiaomi-mimo             → 按量 API 端点，成员仅 v2.6
  │    └─ xiaomi-mimo-token-plan  → Token Plan CN 端点，成员仅 v2.6
  ├─ modelConfigRules.modelRules        → v2.6 能力（裸名/`/` 前缀/`[1m]`，尾缀精确）
  ├─ modelConfigRules.modelApiRules     → v2.6 anthropic thinking map（同上匹配）
  └─ modelConfigRules.templateModelRules → 两模板 v2.6 默认 enabled
                    │ snapshot
                    v
ProviderConfigResolver（packages/provider/src/resolver.ts）
  templatePersonalProviders: template.overlay(personal)
  个人字段优先；仅未声明的字段由模板补缺
                    │
                    ├─> resolvedProviders（设置页展示 / 禁用态 / issues）
                    └─> registryProviders（可执行 Provider 与模型）
```

无新增状态 owner、无异步队列、无远端同步语义变化；手机远控与 Desktop continuous 链路不参与本项。

## 6. 验收场景（MiMo 回归用例）

`docs/model-provider-regression-case-catalog.md` 存在其他工作线未提交改动，本项不修改它；协调合入前
MiMo 回归用例暂记于此。

| Case ID     | 场景与准备                                       | 操作                                                                                                                           | 预期结果                                                                                                                                            | 不应发生                                                                                                |
| ----------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| MIMO-001    | 两个 MiMo 模板同时存在                           | 读取 Built-in 模板                                                                                                             | `xiaomi-mimo` 与 `xiaomi-mimo-token-plan` 都存在，显示名为 API / Token Plan，`baseUrl` 分别为按量端点与 `token-plan-cn` 端点                        | 两模板共用同一 Endpoint；任一模板包含 v2.5；API 模板改名后丢失原身份                                    |
| MIMO-002    | 选择 v2.6 模型                                   | 解析 `mimo-v2.6-pro` / `mimo-v2.6-flash`（两个模板）                                                                           | 1M 上下文、图文音输入、`supportsPdf:false`、`disabled/enabled`、131072 输出上限；Map apply 为 `thinking.type`；默认 enabled 且可进入 Registry       | 落到 200K / 32K 兜底；Token Plan 与 API 得到不同能力；Map 不生效                                        |
| MIMO-003    | 旧 v2.5 实例仍存在                               | 解析 `mimo-v2.5` / `mimo-v2.5-pro`；解析 `mimo-v2.6-pro-ultraspeed`                                                            | v2.5 保持原能力：v2.5 图文音，v2.5-pro 仅文本，均 131072 输出与两档推理；ultraspeed 落通用兜底（200K/32K/无多模态）                                 | v2.5-pro 被 v2.6 规则扩成多模态；ultraspeed 继承 v2.6 能力                                              |
| MIMO-004    | 已有 v2.5 Personal（自定义名称、Key、URL、禁用） | 模板更新后读取解析结果                                                                                                         | 名称、Key、`apiKeyManagementUrl`、URL、`enabled:false`、`personalModelIds`、`modelOrder` 全部保留；v2.5 以 `source: personal` 展示；不进入 Registry | 名称被改成模板名；Key/URL 被清空或替换；禁用被恢复；Personal 文件被写回 v2.6                            |
| MIMO-005    | Token Plan 用户使用海外端点                      | Personal 实例 `templateId: xiaomi-mimo-token-plan`，`baseUrl` 指向 SGP 或 AMS，`tp-` Key                                       | 覆盖 URL、Key 与 Key 管理页保留；Provider 正常进入 Registry；模型为 v2.6 两项                                                                       | URL 被归一化回 CN；`tp-` Key 被拒绝或与 `sk-` 混用                                                      |
| MIMO-006    | 历史会话仍在用 v2.5                              | 打开历史 ModelSelection / Personal `defaultModelSelection`                                                                     | 原选择原样保留，不被静默改为 v2.6；失败时明确提示不可用                                                                                             | 自动 fallback 到 v2.6 且无提示                                                                          |
| MIMO-007    | 厂商 1M 上下文标记                               | 解析 `mimo-v2.6-pro[1m]`、`mimo-v2.6-flash[1m]`、`vendor/mimo-v2.6-pro[1m]`                                                    | 与对应裸 ID 能力完全一致（1M / 131072 / 图文音，Map apply）；`[1m]` 只表达同一型号的 1M 变体                                                        | `[1m]` 变体落 200K / 32K 兜底；把 `[1m]` 当成新型号或任意尾缀通行证                                     |
| MIMO-008    | 聚合站点/网关透传带前缀的模型 ID                 | 解析 `vendor/mimo-v2.6-pro`、`gateway/vendor/mimo-v2.6-pro`（及 flash 对应项）；解析带前缀 `-ultraspeed` 与 `notmimo-v2.6-pro` | 带前缀 v2.6 与裸 ID 能力完全一致（1M / 131072 / 图文音，Map apply）；带前缀 ultraspeed 仍落 200K / 32K / 无多模态兜底；无 `/` 边界近似名不命中      | 前缀 ID 落 200K / 32K 兜底；规则放宽为尾缀通配后 ultraspeed 继承 v2.6 能力；`notmimo-*` 被误当成透传 ID |
| MIMO-UI-007 | 设置页添加供应商                                 | 打开设置 → 添加供应商，查看两个 MiMo 模板；点击 Token Plan 创建                                                                | 两个模板都出现在列表，名称正确，顺序为 API → Token Plan；点击后以 `xiaomi-mimo-token-plan` 创建                                                     | 只剩一个入口；点击 API 模板却创建 Token Plan；端点串用                                                  |

## 7. 验证与未覆盖

- 反例测试落点：
  - `packages/provider-node/test/zcode-builtin-integrity.test.ts`：模板拆分、v2.6 能力与 Map
    apply、裸/带前缀/`[1m]` 变体命中、裸/带前缀 ultraspeed 与无 `/` 边界近似名反例、
    v2.5 规则兼容、生产/测试配置 MiMo 子集 parity、Personal 字段/顺序/历史选择保留。
  - `packages/provider-node/test/zcode-builtin-reasoning-map.test.ts` 与
    `test/fixtures/reasoning-map-before-todo95.json`：v2.6 anthropic Map 已纳入 baseline 等价组，
    不再只走 allowlist。
  - `packages/ui/test/providerTemplatePicker.test.ts`：MIMO-UI-007 的组件级回归，读取正式
    Built-in 配置渲染添加列表并点击创建。
- 实际执行（2026-10-24 复审续作后，最终状态）：
  - `pnpm --dir packages/provider-node test` → 26 files / 257 tests passed。
  - `pnpm --dir packages/provider test` → 22 files / 279 tests passed。
  - `pnpm --dir packages/ui exec vitest run test/providerTemplatePicker.test.ts` → 3 tests passed
    （从包目录运行，验证不再依赖 `process.cwd()`）。
  - `pnpm exec vitest run packages/ui/test/providerTemplatePicker.test.ts` → 3 tests passed
    （从仓库根运行）。
  - `pnpm exec oxfmt --check docs/provider-mimo-templates.md` → 格式通过。
- 复审补测（red 阶段，2026-10-24，仅新增反例、未改实现）：
  - `pnpm --dir packages/provider-node test` → **1 failed / 255 passed**（26 files，1 failed）；
    失败用例为 `MiMo v2.6 规则命中带厂商/网关前缀的模型 ID，且不误伤 ultraspeed`：
    `vendor/mimo-v2.6-pro` 实际解析为 200K、无多模态，而裸 `mimo-v2.6-pro` 为 1M、图文音。
    根因是 `modelMatch` 仍为 `mimo-v2\.6-(?:pro|flash)`，带前缀 ID 不命中。
  - `pnpm --dir packages/provider test` → 22 files / 279 tests passed（本项未改动该包）。
- 复审修复（2026-10-24 续作，最小适配）：
  - 两条 v2.6 规则（`modelRules`、`modelApiRules`）的 `modelMatch` 改为
    `(?:.*/)?mimo-v2\.6-(?:pro|flash)(?:\[1m\])?`，`config/provider/zody-builtin.test.json` 与
    `test/fixtures/reasoning-map-before-todo95.json` 同步；未改既有断言以凑绿，只补新反例。
  - 行为核对：裸名、`vendor/`、`gateway/vendor/` 前缀与 `[1m]` 变体命中且能力与裸 ID 一致；
    `mimo-v2.6-pro-ultraspeed` 及带前缀 `-ultraspeed` 不命中；无 `/` 边界的近似名
    （如 `notmimo-v2.6-pro`）不命中（均由用例断言）。
  - 新增生产/测试配置 MiMo 子集 parity 用例：比较两模板、mimo `modelRules`/`modelApiRules` 与
    `templateModelRules` 及 revision，防止人工镜像漂移。
  - `pnpm --dir packages/provider-node test` → 26 files / 257 tests passed（red 用例转绿）。
  - `pnpm --dir packages/provider test` → 22 files / 279 tests passed。
- 全仓门禁（复审会话实跑，本续作按工作流边界未重跑）：`pnpm typecheck` exit 0；
  `pnpm lint` exit 0（0 errors / 311 warnings）。
- 配置双环境：当前根 `package.json` 没有 `provider:config:sync-test` /
  `provider:config:check-test` 脚本（旧文档仍提及，实际不可执行），因此本轮手工镜像
  `config/provider/zody-builtin.test.json` 并保持 revision 一致；若后续恢复生成脚本，以脚本为准。
- 未执行：真实 Desktop 设置页 E2E（MIMO-UI-007 当前只有组件级证据；需在
  `docs/model-provider-regression-case-catalog.md` 未提交工作线协调后，按 `e2e-case-lifecycle`
  转为正式 case 并补 Desktop E2E）。真实厂商请求（按量 Key、`tp-` Key、v2.6 两个模型、
  SGP/AMS 覆盖）未执行；本文的 v2.6 能力参数仍为上游声明值，不能以配置断言替代线上验证。
  历史会话内的 ModelSelection 不在本项读写路径上（模板升级不触碰会话存储），当前只以 Personal
  `defaultModelSelection` 往返覆盖；如需端到端证据，随上述设置页 E2E 一并补。
