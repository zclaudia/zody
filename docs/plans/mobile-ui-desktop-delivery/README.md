# 移动端主 UI 随桌面交付：Sub-agent 实施编排

状态：M1、M2、M3 与 M4-T1/T2/T3 已完成；M4-T4（删除旧实现与同步规范/发布文档）与 M4-T5 最终验证已完成。Gate M4 在已验证范围内通过，未覆盖平台与环境见 [最终验证记录](../../testing/evidence/mobile-ui-desktop-delivery-final.md)。

唯一产品与技术基准：[移动端主 UI 随桌面交付切换方案](../../../specs/mobile-remote-ui-desktop-delivery.md)。本目录是执行计划，不替代 spec；任务实施发现规则冲突时，停止扩张实现并交回主 agent 对齐，不能自行增加兜底分支。

## 阶段任务书

- [M1：制品与桌面 provider](m1-artifact-and-desktop-provider.md)
- [M2：Shell/Remote 拆分与 Android 双源](m2-android-dual-source.md)
- [M3：发布检测与安全刷新](m3-safe-release.md)
- [M4：文件、通知、回归与清理](m4-parity-and-cleanup.md)

## 执行原则

1. 每个 sub-agent 只执行一个任务 ID，不同时认领多个任务。
2. 严格限制在任务的“独占写文件”范围内；需要修改其他文件时，作为集成依赖交回主 agent。
3. 每个任务先补测试再实现；bug 修复用中文注释说明原因和依据。
4. 保留所有任务范围外的本地改动，不格式化整个仓库，不恢复已删除模块，不提交、不推送、不发布。
5. 跨包导入走公开入口；文件和网络 IO 遵守现有异步/平台约束。UI 遵守 `DESIGN.md`，平台能力经 `IPlatformService`。
6. 不修改 task/session、Host attachment、owner/lease 或 Gateway 业务状态边界；不把 UI 静态代理扩张为通用 API 代理。
7. 测试只报告实际执行结果。环境、签名、平台或设备不支持的验证明确标记“未执行/未验证”。
8. 并行任务不共同修改 spec、根 `package.json`、`vite.config.ts`、Main 装配点或同一测试文件；这些文件只分配给指定任务。
9. 阶段之间默认串行，阶段内只按依赖图并行。主 agent 负责集成、冲突裁决和阶段门禁，不让 sub-agent 互相等待或轮询。
10. 每个 agent 完成后返回：修改文件、接口变化、实际测试及输出摘要、未验证项、阻塞项。证据不得写成笼统“全部通过”。

## 推荐派单格式

```text
读取 specs/mobile-remote-ui-desktop-delivery.md、AGENTS.md、DESIGN.md（涉及 UI 时）
以及 docs/plans/mobile-ui-desktop-delivery/<阶段文件>。
只执行 <TASK-ID>，严格遵守该任务的前置依赖、独占写文件和完成标准。
不要实现后续任务，不要提交或推送。
完成后报告修改文件、测试真实结果、未验证项和需要主 agent 集成的事项。
```

## 依赖图

```text
M1-T1 ──→ M1-T2 ──┐
   ├────→ M1-T3 ──┼──→ M1-T5
   └────→ M1-T4 ──┘

M2-T1 ──→ M2-T2 ─────────────┐
   ├────→ M2-T3 ──┐          │
   │              ├─→ M2-T5 ─┼──→ M2-T6
   └────→ M2-T4 ──┘          │

M3-T1 ──→ M3-T2 ──┐
   ├────→ M3-T3 ──┤
   └────→ M3-T4 ──┼──→ M3-T5
                  │

M4-T1 ──┐
M4-T2 ──┼──→ M4-T4 ──→ M4-T5
M4-T3 ──┘
```

- M1-T1、M2-T1、M3-T1 是各阶段的契约冻结点，未交接前不要启动下游。
- M1-T5、M2-T6、M3-T5、M4-T5 是阶段集成门禁，只能由主 agent 或指定集成 agent 执行。
- M4-T1/T2/T3 可在 M3 验收后并行；清理任务 M4-T4 必须等它们全部完成。

## 阶段门禁

### Gate M1

- Remote 制品确定性地包含入口、资源、release manifest 和 HTML meta。
- 桌面只读 provider 与 `serveHttp` 生命周期连通，路径、缓存和 CSP 测试通过。
- 三平台打包配置包含 Remote 制品；未实际构建的平台明确标记未验证。
- 现有业务 Channel 测试无回归。

### Gate M2

- 新 APK 只包含 Shell，能完成配对、选电脑和 Remote 冷启动。
- 旧桌面、离线桌面、旧 hash、路径逃逸均有明确结果。
- 双 bridge、generation/sessionId、backend 切换和 stale 响应通过 Android 测试与真实 E2E。
- 凭证安全边界与 spec 第 8 节一致，不宣称凭证完全不进页面。

### Gate M3

- 桌面升级/回滚、二次确认、刷新限频、断网保留文档通过。
- 草稿、pending optimistic overlay、设置、文件操作和原生弹窗均能阻止刷新。
- 后台任务刷新后按 replayable 语义恢复，不重复 admission、不新建 Agent/Host。

### Gate M4

- 文件、通知深链、Desktop continuous 与 web-remote-replayable 回归完成。
- 旧完整 Remote assets、旧桥和旧配置路径清理完毕，文档与代码一致。
- 最终验证记录包含目标测试、Android 真机 E2E、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 的真实结果。

## 主 agent 集成检查清单

- 核对每个并行任务是否越权修改文件。
- 检查公开入口、依赖方向、异步 IO、日志级别和凭据脱敏。
- 检查是否出现第二份配置所有者、第二条连接配置写入路径或新的 runtime 状态副本。
- 检查 Remote 失败是否始终有 Shell 出口，旧 generation 是否无法写入新文档。
- 检查测试是否验证实现而非仅验证 mock 自身。
- 运行阶段级测试并审阅真实 diff；不得只依据 sub-agent 总结宣布阶段完成。
