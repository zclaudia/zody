# 桌面构建期可选能力

## 目标

发布构建关闭所有三项能力；ARMS 与事件遥测 endpoint 若被配置会拒绝构建，自动更新真值也会拒绝构建：

| 能力             | 配置项                                           | 关闭时的行为                                                          |
| ---------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| ARMS RUM 上报    | `ZCODE_ARMS_RUM_ENDPOINT`                        | Zody 发布构建固定为空；环境变量或私有默认配置设置 endpoint 时构建失败 |
| 事件上报（数仓） | `ZCODE_TELEMETRY_REPORT_ENDPOINT`                | Zody 发布构建固定为空；环境变量或私有默认配置设置 endpoint 时构建失败 |
| 自动更新         | `ZCODE_AUTO_UPDATE`（`1`、`true`、`yes` 为启用） | 与 Preview 形态相同，不检查、不下载更新                               |

这样构建产物不会携带上报地址，也不能通过发布环境配置意外开启遥测或自动更新。

## 配置来源与优先级

1. `ZCODE_DOWNLOAD_PAGE_URL`、`ZCODE_FEEDBACK_ISSUE_URL` 与 `ZCODE_AUTO_UPDATE` 仍先读构建进程环境变量，再读 `config/private/build-defaults.json`。
2. ARMS、事件遥测与 Agent OTLP 配置不得存在于发布环境变量或私有默认配置中；发现非空 endpoint 时构建失败。
3. 上报字段全部为空且没有私有默认值时，构建注入关闭值。

## 所有者与数据流

```
环境变量 / config/private/build-defaults.json
        │ scripts/build-time-config.mjs（唯一解析入口）
        ▼
desktop tsup（main、host、preload）与 desktop vite（renderer）的 define
        │ __ZCODE_ARMS_RUM_ENDPOINT__ = "" / __ZCODE_TELEMETRY_REPORT_ENDPOINT__ = "" / __ZCODE_AUTO_UPDATE_ENABLED__ = false
        ▼
@zcode/shared env 常量 ── 运行时代码只读这些常量
```

- 未注入 define 的环境（测试、其他 bundle）得到关闭值；单测可以自行 mock 上报 endpoint 验证上报逻辑。
- 自动更新在 Desktop Main 启动时判定：`ZCODE_PRODUCT_FLAVOR === "production" && ZCODE_AUTO_UPDATE_ENABLED`。
- Agent OTLP 不由发布包注入：`ZCODE_PACKAGED_AGENT_OTEL_*` 任一字段被设置时构建失败；运行时会拒绝非空编译常量，并确保打包 Host 不转发继承的 OTEL/遥测连接字段。开发态仍可使用本地 OTEL 环境变量。

## 验收

1. 环境或私有默认配置包含 ARMS、事件遥测或 Agent OTLP endpoint 时，Zody 构建失败；空配置生成空注入值。
2. 没有 endpoint 时 ARMS、事件上报与 Agent OTLP 都无地址注入；自动更新也保持关闭。
3. 打包 Host 不转发外部进程继承的 OTEL/遥测连接字段；开发态仍允许本地 OTEL 配置。
4. 类型检查、Lint 与相关单测通过。
