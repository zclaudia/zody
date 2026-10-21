# 内置默认配置

`config/default.json` 是随客户端发布的默认配置，必须保留。Desktop 正式包从 `resources/config/default.json`
读取（开发态读仓库根的本文件），Web 在构建时导入。

## 帮助配置来源

社群和反馈入口只读本文件，Desktop 与 Web 都不请求远端配置接口，也没有远端覆盖或缓存链路。
字段由 `packages/shared/src/helpAppConfig.ts` 的 `resolveLocalHelpAppConfig()` 解析：

- `community_urls["zh-CN" | "en-US"]`：按当前语言取入口；未配置时该入口不可用，不跨语言回退。
- `feedback_url`：反馈入口地址；未配置时不提供外部地址。
- `feedback_use_external_form`：是否使用外部反馈表单，缺省为 `false`（走应用内反馈）。

```text
config/default.json -> resolveLocalHelpAppConfig() -> Desktop / Web 帮助入口
```

修改入口时直接编辑本文件并随客户端发布；不要在文件中写入凭据或内部服务地址。
