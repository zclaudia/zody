# Provider 内置配置 rev43（F08）

状态：已实施（上游 v3.17.1 · F08），2026-11-03。
上游来源：`3rd-party-repositories/ZCode@a60ba6a7`（v3.17.1 工作区）的
`config/provider/zcode-builtin.json` 与 `zcode-builtin.test.json`，revision 33 → 43。
决策口径：controller 裁决"默认全量对齐 rev43（含 13 个新模板），revision 沿用 43"，无剔除清单。

本文按 [MiMo 模板（I17）](./provider-mimo-templates.md) 的增量式先例记录 rev43 的差异；
Provider Template Schema、Built-in/Personal overlay、Registry 装配、双环境打包与 revision
规则沿用现有实现与文档，不在此重复（见 [builtin-provider-config-build-environments.md](./builtin-provider-config-build-environments.md)）。

## 1. 变更范围（上游 rev33 → rev43 实测增量）

对上游 `0a1fc56d`（rev33）与 `a60ba6a7`（rev43）做逐区块对比，rev33 → rev43 为纯增量：

| 区块                                         | 上游变化                                                                                                | zody 处理                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `providerConfigRules.templateRules`          | +13 个新 BYOK 模板；13 个既有模板新增模型；`opencode-go-*` 三模板顺序重排为 responses → messages → chat | 全量跟随（MiMo 两模板除外，见 §2）                                |
| `providerConfigRules.providerRules`          | 无变化（上游 10 条官方账号 provider）                                                                   | 保持 zody 空列表（fork F4.1a 官方账号下线）                       |
| `modelConfigRules.modelRules`                | 无变化（83 → 83）                                                                                       | 保持 zody 85 条 fork 版，不跟随                                   |
| `modelConfigRules.modelApiRules`             | 无变化（73 → 73）                                                                                       | 保持 zody 73 条，不跟随                                           |
| `modelConfigRules.providerSiteRules`         | +4 条（生产）/ +7 条（测试，含上游重复条目）                                                            | 按上游位置插入，跟随                                              |
| `modelConfigRules.templateModelRules`        | +71 条；3 条删除（minimax M2.1 系）；21 条 `enabled: true → false`（旧型号降级）                        | 跟随；其中 xiaomi-mimo/mimo-v2.5 两条 zody 本就没有，不回填（§2） |
| `modelConfigRules.builtinProviderModelRules` | 无变化（上游 30 条官方账号模型）                                                                        | 保持 zody 空列表（F4.1a）                                         |
| `revision`                                   | 33 → 43                                                                                                 | 43                                                                |

zody 的 `modelRules`（85 条，fork 改名后重写的精确分隔符形态）与 `modelApiRules` 上游
rev33 → rev43 均无变化，本轮不动；新模板成员的能力解析依赖既有家族规则 + 上游模板条目声明。

## 2. 不收录与不改动项（逐条列明）

- **MiMo 区（I17）**：`xiaomi-mimo` 与 `xiaomi-mimo-token-plan` 保持 I17 状态（成员仅
  v2.6）。上游 rev43 在两个模板上仅有的变化是把 v2.5 两条 templateModelRules 从
  `enabled: true` 降为 `false`；zody 从未收录 v2.5 条目（owner 裁决 v2.5 已于 2026-10-21
  停服下线），本轮不回填。zody 的 v2.6 条目与上游 rev43 逐字节一致。
- **`providerRules` / `builtinProviderModelRules`**：上游 rev33 → rev43 无变化，zody 因
  F4.1a 官方账号 provider 下线保持空列表，不因本轮恢复。
- **剔除清单**：无。controller 裁决全量对齐，13 个新模板全部收录，revision 沿用 43。

## 3. 新模板契约（13 个，全部 BYOK `api-key`）

| templateId                | 显示名（zh-CN）                      | api type                  | baseUrl                                                              | builtinModelIds                                                                                             |
| ------------------------- | ------------------------------------ | ------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `kimi-code-cn`            | Kimi Code（国内）                    | `openai-chat-completions` | `https://api.kimi.com/coding/v1`                                     | k3.1-pro、k3.1-pro-highspeed、k3、k3-256k、kimi-for-coding、kimi-for-coding-highspeed                       |
| `kimi-code-intl`          | Kimi Code（国际）                    | `openai-chat-completions` | `https://api.kimi.ai/coding/v1`                                      | 同上                                                                                                        |
| `minimax-m-plan-cn`       | MiniMax M Plan（中国）               | `anthropic-messages`      | `https://api.minimax.cn/anthropic`                                   | MiniMax-M3.1-Flash（enabled）、MiniMax-M3.1-Flash-Preview（默认 disabled）                                  |
| `qwen-coding-plan-cn`     | 阿里云百炼 Coding Plan（中国）       | `openai-chat-completions` | `https://coding.dashscope.aliyuncs.com/v1`                           | qwen3.7-plus                                                                                                |
| `qwen-token-plan-team-cn` | 阿里云百炼 Token Plan 团队版（中国） | `openai-chat-completions` | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | qwen3.8-max、qwen3.8-flash                                                                                  |
| `tencent-tokenhub-cn`     | 腾讯 TokenHub 广州 API（中国站）     | `openai-chat-completions` | `https://tokenhub.tencentmaas.com/v1`                                | hy3、hy4-preview                                                                                            |
| `tencent-tokenhub-intl`   | 腾讯 TokenHub 新加坡 API（中国站）   | `openai-chat-completions` | `https://tokenhub-intl.tencentmaas.com/v1`                           | hy3、hy4-preview                                                                                            |
| `volcengine-ark`          | 火山方舟 API                         | `anthropic-messages`      | `https://ark.cn-beijing.volces.com/api/compatible`                   | doubao-seed-evolving、doubao-seed-2-1-pro-260915、doubao-seed-2-1-lite-260915、doubao-seed-2-1-turbo-260628 |
| `volcengine-coding-plan`  | 火山方舟 Coding Plan                 | `anthropic-messages`      | `https://ark.cn-beijing.volces.com/api/coding`                       | doubao-seed-2.1-pro、doubao-seed-2.1-lite                                                                   |
| `volcengine-agent-plan`   | 火山方舟 Agent Plan                  | `anthropic-messages`      | `https://ark.cn-beijing.volces.com/api/plan`                         | doubao-seed-2.1-pro、doubao-seed-2.1-lite                                                                   |
| `stepfun`                 | 阶跃星辰 API                         | `anthropic-messages`      | `https://api.stepfun.com`                                            | step-5-preview、step-3.7-flash                                                                              |
| `stepfun-step-plan`       | 阶跃星辰 Step Plan                   | `anthropic-messages`      | `https://api.stepfun.com/step_plan`                                  | step-5-preview、step-3.7-flash                                                                              |
| `siliconflow-cn`          | 硅基流动 API（中国）                 | `openai-chat-completions` | `https://api.siliconflow.cn/v1`                                      | zai-org/GLM-5.3、deepseek-ai/DeepSeek-V4-Flash、moonshotai/Kimi-K2.7-Code                                   |

规则（与 I17 的模板拆分原则一致）：

- 同厂商多套餐模板（Kimi Code 国内/国际、TokenHub 广州/新加坡、火山按量/Coding/Agent、
  阶跃 API/Step Plan）是独立身份：`templateId` 是身份 key，`baseUrl` 互不相同，也不得
  与既有模板端点重复（测试断言全模板 baseUrl 唯一）。
- 火山按量模板的成员是带日期后缀的 `doubao-seed-2-1-*`，套餐模板是 `doubao-seed-2.1-*`：
  不同型号 ID，`templateModelRules` 按 `templateId + modelId` 精确命中，互不串用。
- `MiniMax-M3.1-Flash-Preview` 按上游声明默认关闭；enabled 成员仍须构成
  `builtinModelIds` 前缀（既有不变量，测试保持）。
- 不新增 Provider 类型或 Access 类型；全部为 `api-key`，不携带 Key。

## 4. 既有模板更新（跟随上游 rev43）

- 新模型：`zai-standard-api` +`glm-5.3-flashx`；`moonshot-kimi` +`kimi-k3.1-pro(-highspeed)`；
  `minimax` +`MiniMax-M3.1-Flash`、删除上游已移除的 `MiniMax-M2.1(-highspeed)`/`MiniMax-M2`；
  `openai` +`gpt-6.1-sol`/`gpt-6-luna`；`anthropic` +claude-5.5 系三款；`xai` +`grok-4.7`；
  `openrouter` +11 款透传 ID（含 `z-ai/glm-5.3-flashx`、`x-ai/grok-4.7`、mimo v2.6 系）；
  opencode 系模板按上游增补成员。
- 旧型号降级：上游把 19 条既有 templateModelRules 从 `enabled: true` 改为 `false`
  （openai/anthropic/xai/openrouter/opencode 下的上一代旗舰与 `minimax/MiniMax-M2.7` 系），
  zody 同步；Personal 已保存的禁用/启用状态不受影响（Personal 优先，不写回）。
- 顺序：`opencode-go-responses → messages → chat` 跟随上游重排（影响模板列表与 Registry
  顺序）；其余模板相对位置不变。

## 5. 站点规则（providerSiteRules +4）

- `glm-5\.3` + `anthropic-messages` 在 `https://api.z.ai/api/anthropic`、
  `https://open.bigmodel.cn/api/anthropic`、`https://zcode.z.ai/api/v1/highspeed/anthropic`
  三个端点 `supportsVideo: false`。`zcode.z.ai` 的 URL 保留：siteRule 按 baseUrl 匹配，
  服务用户自建 provider 指向该端点的场景，与官方账号 provider 下线（F4.1a）不冲突。
- `.*` + `openai-chat-completions` 在 `https://opencode.ai/zen/go/v1` 端点
  `supportsJsonSchemaOutput: false`。
- 测试配置（`zcode-builtin.test.json`）按上游镜像 +7 条（glm-5.3 三条各重复两次，
  与上游一致）；生产配置 +4 条。

## 6. 状态所有者与组合顺序

```text
config/provider/zcode-builtin.json（唯一编辑源，revision 33 → 43）
  ├─ providerConfigRules.templateRules      → 34 个 BYOK 模板（MiMo 两模板保持 I17 状态）
  ├─ modelConfigRules.providerSiteRules     → 58 条（glm-5.3 视频限制 + go JSON Schema 限制）
  ├─ modelConfigRules.templateModelRules    → 314 条（上游 316 − MiMo v2.5 两条）
  └─ modelRules / modelApiRules / providerRules / builtinProviderModelRules → 不动
                    │ snapshot（zcode-builtin.test.json 手工镜像，revision 43）
                    v
ProviderConfigResolver（packages/provider/src/resolver.ts）
  templatePersonalProviders: template.overlay(personal)
  个人字段优先；模板成员增删只影响未由 Personal 声明的字段
                    ├─> resolvedProviders（设置页 / Picker 入口按模板顺序展示）
                    └─> registryProviders（新模板补齐访问材料后进入 Registry）
```

无新增状态 owner、无异步队列、无远端同步语义变化；模板升级不写回任何 Personal 配置
（与 I17 §4 同一规则，适用于 13 个新模板与既有模板的成员变化）。

## 7. 验收场景（F08 回归用例）

| Case ID | 场景              | 操作                                                              | 预期结果                                                                           | 不应发生                                        |
| ------- | ----------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| F08-001 | 新模板全量收录    | 读取 Built-in 模板                                                | 34 个模板；13 个新模板名称/端点/成员与 §3 一致；全部 baseUrl 互不相同              | 新模板缺失；复用其他模板端点；携带账号 provider |
| F08-002 | 新模板成员解析    | 逐成员 resolve（模板上下文）                                      | `validateComplete` 为空；enabled 与上游声明一致（Preview 默认关闭，其余启用）      | 成员落 200K/32K 兜底；doubao 两种型号 ID 串命中 |
| F08-003 | 不串命中          | `minimax` 模板下 resolve `MiniMax-M3.1-Flash-Preview`             | enabled 保持默认 true（未命中 `minimax-m-plan-cn` 的 disabled 声明）               | 按 modelId 全局串命中后被错误关闭               |
| F08-004 | 既有模板更新      | 读取 openai/anthropic/xai/minimax 等模板                          | 新模型在列表且默认启用；上一代型号默认关闭（enabled 前缀保持）                     | 旧型号仍默认启用；minimax M2.1 系残留           |
| F08-005 | 站点规则          | `glm-5.3` 在 z.ai/bigmodel/zcode-highspeed Anthropic 端点 resolve | `supportsVideo: false`；go 端点 chat-completions `supportsJsonSchemaOutput: false` | 站点限制未生效                                  |
| F08-006 | 双环境 parity     | 比较生产与测试配置的 F08 子集                                     | 13 新模板 templateRules/templateModelRules 与去重后 siteRules 一致；revision 均 43 | 人工镜像漂移                                    |
| F08-007 | Picker 入口（UI） | 正式配置渲染添加供应商列表并点击创建                              | 13 个新模板全部出现（官方双语名）并以正确 templateId 创建                          | 不支持的厂商出现；点击 A 创建 B                 |

MiMo 区回归（MIMO-001 ~ MIMO-UI-007）沿用 I17 用例不变，本轮未改动其行为。

## 8. 验证与未覆盖

- 反例证据（修复前失败 / 修复后通过，2026-11-03 实跑，rev33 配置 + rev43 断言）：
  - `packages/provider-node/test/zcode-builtin-integrity.test.ts` → 7 failed / 15 passed；
    写入 rev43 配置后 22 passed。
  - `packages/ui/test/providerTemplatePicker.test.ts` → 1 failed / 3 passed；写入后 4 passed。
- 测试落点：
  - `packages/provider-node/test/zcode-builtin-integrity.test.ts`：F08 三个新用例
    （F08-001/002/003 + F08-005/006 断言）与既有断言更新（§4 列表、Registry 顺序、
    enabled 前缀、gpt-5.6-sol 降级）。
  - `packages/provider-node/test/opencode-go.test.ts`：Go 端点成员/enabled 更新；上游把
    gpt-6-luna、grok-4.7、claude-haiku-5-5 等新成员的能力与参数声明在模板条目（无对应
    通用规则），这些成员不再断言与自建供应商（manual）一致，改为断言模板条目声明生效。
  - `packages/ui/test/providerTemplatePicker.test.ts`：F08-007 组件级回归。
- 实际执行（2026-11-03，fnm node 24.14.0）：
  - `pnpm --dir packages/provider-node test` → 263 passed / 1 failed（`builtin-provider-build`
    为 vitest 5s 超时 flake，底层 `node --test scripts/test/builtin-provider-config-build.test.mjs`
    单独实跑 14 pass / 0 fail，耗时 8.6s 超出 vitest 默认超时；基线同样失败，与本卡无关）。
  - `pnpm --dir packages/provider test` → 277 passed / 2 failed（`m2-completion-boundary` 的
    providerRevision 边界失败与 5s 超时均为本卡改动前的既有基线失败，与本卡无关）。
  - `pnpm --dir packages/ui exec vitest run test/providerTemplatePicker.test.ts` → 4 passed。
- 未执行：真实厂商请求（13 个新端点的连通性、鉴权、模型实际能力）未验证，能力参数为
  上游声明值；真实 Desktop 设置页 E2E 未执行（F08-007 为组件级证据）。
