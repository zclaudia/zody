# Controller 审查记录

本续作由 DeepSeek（deepseek-flash / magpie / commandcode-plan/deepseek/deepseek-v4.1-flash）实现，controller 查源码、diff并独立执行。worker ID与文件分工见产品接线计划。修改前先更新 spec；保留开工时未提交改动及旧冻结归档。

发现并要求实现方修正的实际问题：

- scope 自己发起的成功 revoke 会同步收到 owner 失效回调；初稿据此把真实 revoked 回执改成 unknown。修正为保留同 owner 已提交事实，晚到 candidate 仍拒绝。
- TS readonly 不阻止运行期改写身份。scope 改为私有捕获字段、冻结实例及完整 ref 检查。
- foreground parent abort 早于 held model 返回时不能等 turn finish 才失效；改为直接订阅真实 AbortSignal。
- pre-spawn hook 在中间 launcher wrapper 丢失，初稿没有真正 bind。同一份 launcher material 现贯通到实际 spawn 前。
- stop/inbound 自己触发的 scope 撤销不能抢先推进 epoch、关闭 child，否则真实控制消息和 ACK 被取消；沿用原控制会话自身撤销的时序。
- normal scope close 不能变成 control-lost 撤销；consumer cleanup须结束原 binding并退订。
- shutdown 必须先由 authority 提交真实撤销，再发 scope 通知；不能在 owner 仍是 candidate 时通知 owner-revoked。
- authority dispose 后可能只剩 unknown，adapter 不得把原 candidate ref 作为撤销事实转发；只能记录未取得回执并关闭连接。

调查结论也经过复核：最初 worker 将 `--jitless` 与 native addon 风险概括成 CLI 启动 blocker。controller用固定签名 Node 运行现有已构建 CLI bundle 的 `--help` 成功（不是本轮接线源码的新 CLI 构建证明）；worker重新核对后确认 ripgrep 是 lazy 路径且已有 JS fallback，撤回启动必失败结论。没有实跑的 native addon/library validation 仍是未验证项，不列为已证实失败。

验收区分三件事：固定签名 Helper 自身的真实截图与撤销、生产 runtime owner 的实际组合接线、可信产品启动装配。前两者的成功不能推导第三者完成。默认功能开关保持关闭，不发布 finalFrame，也不宣称 native input Fenced。

## 原生组合候选审查

controller对照R11冻结清单确认34个原生输入固定；3个patch均核对before/after摘要并实际编译链接。签名严格verify通过，Node资源、Helper identifier/DR及空entitlements未放宽。首次实跑失败后，仅补有界reason和Node stderr诊断，查到visual-wait-failed；原R11同时失败且CUA证实Mac锁屏，因此不改视觉ABI或授权算法掩盖环境问题。新链路scope-bound及失败EOF后真实owner撤销成立，正常实拍等待解锁。

## 解锁后最终复核

同一签名候选在解锁后、窗口仍为333×222缩略状态时失败；CUA Raise目标窗口并刷新为1200×800边界后成功。没有源码、签名或权限变化。实际PNG2400×1600，scope关闭原因owner-revoked、真实owner撤销回执及机器锁重新获取均通过。故纠正先前“锁屏为唯一根因”的过强表述：已确认当时锁屏，后续窗口展示状态同样影响采集，具体底层失败码未单独展开；无需为这次成功验收扩native ABI。产品Host/模型仍为明确fixture，安装版入口尚未接入。
