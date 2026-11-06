# R20 runtime A + CUA：主控复核

源码基线 `2d9e7d398037df3c42ad7b97fe1eed8713196701`，集成父提交 `cc19c32b91bb1ea80e9a7018d3b87b48f8e3d3e6`。两者之间仅有 Docker 和元数据变更。主控核对全部 288 个产品/spec/图文件的基线与候选 SHA，精确集合与实施审计一致；本批登记 538 条运行时声明及 1 个 CUA JS/声明配对导出。图只更新 7 个实际符号叶子，节点 372、边 726 不变。Terra 同行检查及跨语言扫描未发现本批绑定遗漏；`createZCodeApp` 的 compact MJS 消费者属于尚未实施的 B 组。

主控使用 Node 24.14.0 / pnpm 10.33.2 独立执行，完整 argv、cwd、退出码在 `output/zody-rename-validation/runtime-a/{commands,followup-commands}.json`：

- 根实际执行 80 文件，1,055 项通过、1 项失败、1 项跳过，退出 1。失败揭示 `agentProxyEnv.test.ts` 的源码结构断言仍用旧内部 resolver 名；实施者同步该断言和相关注释后，主控单独复验 21/21，退出 0。保留首次失败，没有把首次整套结果改为通过，也没有重复运行已通过的其余测试。请求集中的 Desktop E2E 文件受根配置明确排除，未执行，不计入上述 80 文件。
- CLI 根 Vitest 4.1.7 实际执行 36 文件、514 项通过，退出 0。CLI Node runner 的 5 个受影响文件分两组执行，共 254 项通过，均退出 0。dev-docs 图回归 4/4，退出 0。
- 根 typecheck 和 lint 均退出 0，lint 303 warnings、0 errors。CLI 强制 build 23/23、0 cached 及 CLI typecheck 34/34 来自实施者真实命令记录；主控未重复构建。changed architecture 通过来自实施者记录。
- 主控单独 Desktop Main 检查退出 1、85 条诊断。与 `controller-types106-main.log` 原始字节完全一致，无需名称或联合类型归一，详见 `runtime-a/main-comparison.json`；不将其报告为通过。

bootstrap 首项原有两次 5000ms 超时仍保留。固定祖先 7c 单次通过，不能把候选失败归为已证旧基线。独立阶段计时显示一次候选动态导入耗 4877.75ms、工厂约 0.4ms、两次 mock refresh 合计约 1.17ms；该采样支持模块加载接近阈值，不能证明原失败的精确时间分布。确认无 mock/resetModules 加载边界后，将固定依赖移至模块加载阶段，保留 5000ms 和全部业务断言；实施者单次 5/5 通过，主控上述 36 文件运行也覆盖并通过该文件。未增加等待或吞掉错误。

独立审查前状态为主控复核完成。剩余 B/C/D、R20.5、完整 R21/R22 及发行门禁尚未完成；本批没有修改外部 Error.name、ServiceChannels、env/wire/持久化字段、插件身份或冻结 native 原件。
