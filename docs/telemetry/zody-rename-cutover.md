# 遥测名称切换与看板交接

本文件供看板所有者迁移查询；本次不访问或修改线上看板。实际切换时间由发布负责人填写，旧时间段继续查询旧名称，新时间段查询新名称；合并时保留原聚合、单位、资源标签和时间边界，避免将同一逻辑事件按两套名称重复计数。

| 原名称 | 新名称 | 范围 |
| --- | --- | --- |
| `zcode-cli-agent` | `zody-cli-agent` | CLI 默认 `service.name`；显式 `OTEL_SERVICE_NAME` 不变 |
| `@zcode/cli-agent-telemetry` | `@zody/cli-agent-telemetry` | CLI span 与 metric scope |
| `zcode.<metric>` | `zody.<metric>` | CLI 指标及对应 view；后缀、单位和 histogram 边界不变 |
| `zcode.<attribute>` | `zody.<attribute>` | CLI 自有 resource 与 span 属性；标准 OTel/第三方键不变 |
| `zcode-desktop-renderer` | `zody-desktop-renderer` | renderer trace service |
| `@zcode/desktop-renderer-action-trace` | `@zody/desktop-renderer-action-trace` | renderer span scope |
| `@zcode/local-ttft` | `@zody/local-ttft` | TTFT scope；span 与 metric 按各自语义统计 |
| `perf_resource_zcode_data_size` | `perf_resource_zody_data_size` | Desktop 本机数据大小事件 |
| `zcode_data_bytes` | `zody_data_bytes` | data-size metric_kind 和数值属性，单位字节 |
| `zcode_protocol.*` | `zody_protocol.*` | CLI 结构化日志事件 |
| `bootstrap.zcode_protocol*` | `bootstrap.zody_protocol*` | 相应结构化日志 module |
| `zcode_agent.model.<provider>.<transport>.<endpoint>` | `zody_agent.model.<provider>.<transport>.<endpoint>` | Agent 网络 interface；后缀规范化不变 |
| `[zcode-agent-lifecycle-reported]` | `[zody-agent-lifecycle-reported]` | Host 事件与 Desktop 重复抑制标记 |

各个具体 metric、属性与事件的映射由对应生产文件的最终输出与冻结清单核对，旧事件的历史值不回写。`zcode:session_create:v1` 是稳定 event ID 的 hash 输入而非看板标签，不改名；重试可产生多个 HTTP 批次但仍为同一个逻辑事件。发布负责人需记录实际切换时间和受影响看板负责人，再分段对照旧新查询。
