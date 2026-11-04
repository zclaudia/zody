# R40 活跃错误值切换

基线 `19d608d0a910f33247779b7a1f56d4f6a72557bf`，tree `df9995399dc123cb795f4744c1686e1155c1419d`；按授权单写范围先写 `specs/zody-rename-error-values.md`，新增回归在旧值上产生预期红测，再将文件锁、MCP status-only、provider 未就绪、Agent runtime 不可用和 UI runtime model 不可用五个活跃 code 的品牌前缀切换为 `ZODY_`。通用 RPC 不改，`provider_not_ready` reason 和 `zcode.error` locale namespace 不变。历史 code/message 原样保留为普通错误，无旧 live alias 或数据库改写；现行文档明确 model code 是 SessionPane 局部发送错误，而非已证实的服务生产值。

验证记录在 `output/zody-rename-r40-error-values/implementation/`，每个 runner JSON 含 argv、隔离 HOME/USERPROFILE/TMP/XDG、固定 Node/pnpm PATH、退出码和 log SHA。基线和修改后 architecture check 均 exit 0。`red-contracts` 4 文件、5 个预期断言失败；`red-rpc` 旧值回归失败，原始日志保留。切换后：

- `scope-cleanup-tests`：13 文件、370 测试通过，含真实 AgentService 产生的 provider/runtime 错误经 ChannelServer/ChannelClient 往返，及 MCP 错误类的真实通道往返。
- OAuth lease 与 refresh 分别新增新/旧 timeout code 分支测试，7/7 和 10/10；原 OAuth 三文件含真实双进程测试 17/17。各轮测试重叠，不相加为唯一数量。
- `bootstrap-history` 53/53；UI 恢复与 projection 保留旧 code/message，JSON 输入前后不变；双语言当前 code 展示及旧 code 普通 message、旧 live 锁/provider/runtime/MCP 分类负例通过。该 fixture 未读取真实用户 DB，不声称已对实际用户库逐字节验证。
- `lint-minimal` exit 0，2 个既有 SessionPane 未使用变量 warning；`git diff --check` 无空白错误。正式根 `pnpm typecheck`、`pnpm lint` 与最终统一架构检查由主控在写入停止后执行，不在本报告标为已完成。

本次没有修改 runtime/session 状态所有者、数据持久化或通道拓扑；保留 desktop-continuous 和 web-remote-replayable 路径的现有定向测试。错误展示逻辑改的是 code 分类与现有文案，不改交互布局；没有运行正式桌面 UI E2E，须单独记录此限制。没有执行完整发行构建或安装；既有 R22 失败保持原归属。现有 OAuth 跨进程 E2E 和服务 v4 通道测试不等同完整 Desktop 交互验收。

当前范围内未对旧码的每一个消费者分别注入旧值：旧 runtime background-output 分支与旧 provider 的全部 UI 发送入口依赖同一精确比较和既有回归，尚无单独旧值注入；历史只用内存 JSON fixture，未进行真实 DB 文件字节比对。这些是可供独立审查判断的验证边界，不扩充产品兜底。

`ZCODE_BIGMODEL_TEAM_PLAN_MEMBER_REQUIRED` 经 `output/zody-rename-w5-preflight/R40-bigmodel-code-owner-19d608.md` 定点核对，仅有 UI 显示集合及两种翻译，未发现当前生产者；它是已删除官方套餐业务的历史显示遗留，并非已证明的第三方返回契约。本批保留该值及翻译，不恢复业务、不将其计入五个活跃值。

独立 code review 指出的现行文档歧义已修正：仅新 model code 且消息符合现有历史模型不可用判据时抑制 banner；旧 code 保持不透明并按普通历史 message 显示。该修订只改文档，不改变产品或测试。
