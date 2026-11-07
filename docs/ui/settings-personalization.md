# 设置页「个性化」（用户自定义指令）

## 问题摘要

用户自定义指令（Personalization）：用户写一段全局指令，本机 Agent 的所有后续会话都遵守。落点为设置页「Agent 能力」分组第一项「个性化」（位于「记忆」之前），单层直达编辑器，不经过列表 → 二级编辑页跳转。

来源：上游 v3.17.1（commit a60ba6a7）`packages/shared/src/userInstructions.ts`、`packages/services/src/setting/settingService.ts`、`packages/ui/src/settings/PersonalizationSection.tsx` 的语义移植；路径按本仓 ZODY 数据根适配（见下）。

## 单一事实源与路径规则（本仓适配）

编辑器读写的文件就是本仓 CLI 已有的用户级默认指令文件 `{home}/.zody/AGENTS.md`，不新增存储：

- CLI 侧 `apps/zody-cli/packages/adapters/src/context/index.ts` 的 `resolveUserInstructions` 已把它作为 `scope: "user"` 的指令源，与 workspace `AGENTS.md` 一起注入每个会话（读取上限 100KB，超出静默截断）。因此「保存即生效于后续所有会话」，无需协议或 CLI 改动。
- **home 解析必须与 CLI adapter 完全一致**：`env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir()`（对齐 `context/index.ts` 的 `resolveUserHomeDir`）。services 侧**不得复用 `getDataBaseDir()`**：它认 `setDataBaseDir()` 与 `ZODY_DATA_BASE_DIR`，而 CLI 读该文件时忽略两者，复用会造成 App 写的文件与 Agent 读的文件分叉。也不引入其他覆盖变量（CLI 子进程不认）。
- **目录名只用共享常量** `ZODY_DATA_ROOT_DIR_NAME`（`packages/shared/src/dataDir.ts`，`".zody"`，fork 数据隔离），不得手写 `~/.zcode` 或字面量 `".zody"`。
- 文件缺失或内容为空等价于未配置；文件不存在不是错误。

## 接口与依赖方向

```text
packages/shared/src/userInstructions.ts（新建）
  ├─ USER_INSTRUCTIONS_MAX_BYTES = 100 * 1024
  └─ USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE = "user_instructions_too_large"
packages/services/src/paths.ts
  ├─ resolveAgentUserInstructionsHomeDir(env)   // 只认 HOME/USERPROFILE，规则见上
  └─ getAgentUserInstructionsFilePath(env)      // join(home, ZODY_DATA_ROOT_DIR_NAME, "AGENTS.md")
packages/services/src/setting/setting.ts（ISettingService 扩展）
  ├─ getUserInstructions(): Promise<{ content: string; filePath: string }>
  └─ saveUserInstructions(content: string): Promise<{ filePath: string }>
packages/ui/src/settings/PersonalizationSection.tsx（新建，挂 SettingsPage）
```

- 依赖方向：`shared`（常量与路径语义，无 IO）← `services`（读写与校验）← `ui`（表单）。UI 不直接做文件 IO，不自行拼接路径。
- 100KB 常量是 shared 单点：services 最终校验与 UI 预检都引用它；它与 CLI adapter 的 `DEFAULT_MAX_BYTES`（`context/index.ts`，100 \* 1024）必须同值同义，**两侧改动必须同步**（CLI 读前 100KB，保存侧拒绝超限，口径不一会让用户误以为全部生效）。

## 服务层读写语义（事件顺序与幂等边界）

- `saveUserInstructions(content)` 事件顺序：
  1. 字节数校验（`Buffer.byteLength(content, "utf8") > USER_INSTRUCTIONS_MAX_BYTES` → 抛 `code = USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE` 的错误；服务端校验是最终防线，防止其他 RPC 调用方绕过 UI 写入超限内容）；
  2. 进程内 FIFO 写队列串行化（同一 settingService 实例内）：原子替换只保证单次写入完整，慢 IO 下旧写的 rename 晚到会用旧内容覆盖新内容；排队后队尾写入即最新内容；
  3. **按需创建父目录（`{home}/.zody`）必须发生在取文件锁之前**：锁文件以不带 `recursive` 的 `mkdir` 创建，父目录不存在时取锁直接 ENOENT，首次保存（CLI 从未运行过的 home）会永远失败；
  4. `withAtomicFileLock`（既有 `packages/services/src/fs/atomicFileUtils.ts`）内原子替换写入；
  5. **写入权限固定私有 `0600`**：现有 `atomicWriteText` 临时文件不带 mode，rename 换 inode 会把既有 `0600` 文件放宽为 umask 默认（常见 `0644`），同机其他账号可读用户指令；需提供私有写入变体（临时文件 `0600` 后 rename，只会收紧不会放宽）。
- `getUserInstructions()`：先 `await` 写队列排空再读（保存后立即重开分区不能读到旧内容）；`ENOENT` 返回 `{ content: "", filePath }`；其他读错误向上抛（UI 按读取失败处理，不得当空文件）。
- 幂等边界：重复保存相同内容是普通文件覆盖，结果幂等；写失败不留半成品（临时文件 + rename）；多 Host 跨实例并发写本文件尚无版本仲裁（当前桌面为单 Host，不构成现实路径，登记为已知边界）。

## 100KB 上限口径（与 CLI adapter 一致）

- CLI 读取侧：`readFirstTextBytes` 取前 `maxBytes` 字节，超出部分静默截断（Agent 不读）。
- 保存侧：超过 100KB 硬拒绝（错误码见上），杜绝「保存成功但 Agent 静默截断」的误判。
- UI 预检：按 UTF-8 字节计数显示 `x KB / 100 KB`；超限阻断保存并提示（destructive 文案）。
- 验收口径：同一份 ≤100KB 内容，经 `saveUserInstructions` 保存后由 CLI adapter `resolveUserInstructions` 读取必须完整不截断且路径一致；多字节字符按 UTF-8 字节计（非字符数）。
  - 该口径由 `packages/services/test/settingUserInstructions.test.ts` 的「与 CLI adapter 读取同口径（PZ03 实测）」组**实测执行**：经 adapter 公开入口（`createNodeContextSourceAdapter().resolveContextSources`）真实读取服务侧保存的文件（常规内容 + 恰好 100KB 边界），断言路径一致、内容完整、`truncated` 为 false；并从读取侧实测外部超限文件只读前 100KB 且 `truncated` 为 true（与保存侧硬拒同口径）。常量比对（PZ07）只防「上限值漂移」，路径与读取语义漂移由这组实测兜住。

## UI 行为与状态所有权

- 侧栏「Agent 能力」组第一项（`packages/ui/src/settings/settingsPageConfig.ts` 的 `agentCapabilities` 组、`memory` 之前）；单层直达：标题（设置页框架渲染）→ 说明 → 编辑器直接铺在页面背景上（无卡片包裹）→ 保存/取消操作区。
- **平台差异（本步验收点）**：
  - 仅桌面本地入口（`isDesktop`）渲染编辑器，且 `settingService` 必须取**本地 Host** 的实例（`localHostServices.settingService`，同 Memory 分区先例）：手机远控/Web 的 base services 可能归属远程 Source（`remoteWorkspaceServiceCollection` 会把远程 Source 的 `settingService` 注册进该 workspace 的服务集合），文件路径不是跨机器身份，编辑会写错机器。
  - Web/手机端该分区只显示「请前往本地桌面端」指引文案，**不发起任何读写调用**（同 `MemorySettingsSection` 的 localOnly 先例）。
  - 桌面端激活远程 workspace 时编辑的仍是本机文件（远程 Agent 的指令文件属于远端机器，本功能不覆盖）。
- **显式「保存/取消」**：保存仅脏态且未超限可用；取消丢弃修改恢复基线；`Ctrl/Cmd+S` 与保存等价（阻止浏览器保存对话框）；脏态有未保存提示。不做自动保存、卸载冲刷或 localStorage 暂存。
- **草稿状态唯一所有者是组件外的模块级 zustand store**（不是组件 state、不是全局 settings store）：保存中切走分区时组件卸载，草稿需要存活 owner 才能重试与复制。store 卸载不失活：重进分区时文件内容仍等于基线（未被外部改过）则恢复草稿；文件已被外部改动时文件优先。
- **双层失效边界**：`generation` 绑定 `settingService` 实例身份（连接边界，Web 远控切换桌面/重连时整体重置，旧连接在途回调失效，避免把 A 桌面草稿带到 B 桌面）；`loadRequestId` 标记每次读取请求（请求边界，迟到的旧读取不得覆盖新草稿与基线）。两个版本是不同的时序边界，不能共用。
- 读取成功前编辑器禁用；读取失败展示失败文案与「重试」按钮，**不得把读取失败当空文件建立基线**（否则用户输入无法安全保存）；文件不存在（ENOENT）则是空编辑器、直接可编辑。
- 指令是自然语言，编辑器不用等宽字体；文案走 i18n；日志用 `packages/ui/src/logger.ts` 的 `logger.warn`，不用 `console`。

## 状态与事件

```text
磁盘文件 {home}/.zody/AGENTS.md（内容唯一事实源）
  └─ settingService 写队列（同一实例内写顺序唯一所有者，FIFO）
       ├─ saveUserInstructions(content)
       │    ├─ bytes > 100KB ──────────────> 抛 user_instructions_too_large（不入队）
       │    └─ mkdir(parent) → fileLock → atomic 0600 write
       └─ getUserInstructions()（先排空队列再读；ENOENT → ""）

UI 模块级草稿 store（PersonalizationSection 私有，卸载不失活）
  ├─ beginLoad(service)        generation 随服务实例变化重置
  ├─ markLoadSuccess/Error     loadRequestId 迟到丢弃
  ├─ setDraft / cancel         草稿只在本 store，不落盘
  ├─ beginSave                 使在途读取失效（保存落盘后旧读取是旧快照）
  └─ endSaveSuccess/Failure    失败保留草稿可重试
```

## 验收用例

| ID   | 层级    | Setup                       | Action                            | Assertions                                                                          |
| ---- | ------- | --------------------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| PZ01 | service | 空临时 home                 | 保存 ≤100KB 内容                  | 自动创建 `{home}/.zody/AGENTS.md`；读回内容与路径一致（读写往返）                   |
| PZ02 | service | 同上                        | 保存 100KB+1 字节（含多字节字符） | 抛 `user_instructions_too_large`；文件不被写入/覆盖                                 |
| PZ03 | service | 恰好 100KB（UTF-8 字节计）  | 保存                              | 成功；CLI adapter `resolveUserInstructions` 读取完整不截断（同口径验证）            |
| PZ04 | service | 文件不存在                  | getUserInstructions               | 返回 `{ content: "", filePath }`，不抛错                                            |
| PZ05 | service | 连续两次保存不同内容        | 并发提交                          | FIFO：最终文件内容为队尾（最后一次）内容                                            |
| PZ06 | service | 已有文件                    | 保存                              | 写入后文件权限为 `0600`（不放宽既有权限）                                           |
| PZ07 | shared  | —                           | 常量比对                          | `USER_INSTRUCTIONS_MAX_BYTES` === CLI adapter `DEFAULT_MAX_BYTES`（100KB）          |
| PZ08 | UI 单测 | Web/手机（isDesktop=false） | 渲染分区                          | 只显示「请前往本地桌面端」指引；`getUserInstructions`/`saveUserInstructions` 零调用 |
| PZ09 | UI 单测 | 桌面、读取失败              | 渲染分区                          | 编辑器禁用 + 重试入口；草稿基线不建立                                               |
| PZ10 | UI 单测 | 桌面、超限草稿              | 点击保存 / Ctrl(Cmd)+S            | 保存被阻断并提示；`saveUserInstructions` 零调用                                     |
| PZ11 | UI 单测 | 草稿未保存                  | 切走分区再回来                    | 草稿恢复（文件未变时）；取消恢复基线                                                |

## E2E 场景清单

按 `.agents/skills/e2e-case-lifecycle/SKILL.md` 现行规则：实现步骤在 `packages/desktop/test/e2e/settings/manual-review/pending/` 新建 pending 案例，人工确认后经 `e2e:promote` 转正并登记覆盖证据；本节为场景清单（语义均已在本 spec 定义，无 undefined 项）：

- E1 侧栏「个性化」是「Agent 能力」组第一项，点击直接出现编辑器（无二级页、无卡片）。
- E2 首次进入时 `{HOME}/.zody/AGENTS.md` 不存在也显示空编辑器；输入不创建文件，点击保存后才创建并落盘（e2e 将 `HOME`/`USERPROFILE` 指向隔离目录）。
- E3 离开再进入分区内容回显（文件为唯一事实源）；取消丢弃修改、文件不变。
- E4 超过 100KB（含多字节字符）保存被阻断并提示，回到限内后保存恢复。
- E5 保存 in-flight 时切走分区、写入失败后，重进分区草稿恢复且重试保存成功（用测试进程持有 `AGENTS.md.lock` 构造确定性失败时序）。
- E6 Web 远控/手机端入口只显示本地桌面端指引，个性化读写服务零调用（以服务调用零不变量断言，不依赖 UI 文案）。

## 剪枝

- 不做多 Host 跨实例写仲裁（单 Host 是当前现实路径，登记为已知边界）。
- 不覆盖 CLI adapter 指令合并/优先级等一般等价类（由 `apps/zody-cli/packages/adapters/tests/fs-context.test.ts` 持有）。核实修正（2026-11-08）：CLI 侧既有测试**并未**覆盖用户指令 100KB 截断（fs-context 的 maxBytes 用例只针对 `fs.readBinaryFile`），用户指令读取侧截断由本域 `settingUserInstructions.test.ts` 经 adapter 公开入口实测持有（见「100KB 上限口径」节）。
- 不新增协议命令、watcher、自动保存或外部编辑器打开能力。
- 「应用已启动但 `{home}/.zody` 缺失」无法在 UI 级 E2E 构造（桌面 Host 启动即建目录），首次保存建目录分支由服务层测试（PZ01）与顺序结构保证。
