# 第七轮 controller 验收归档

2026-10-28，macOS arm64，Node24.14.0，固定Rust1.97.1。完整结论与复跑见 [第七轮计划](../../../../../../docs/plans/computer-use-macos-phase1-round7.md)。

实际依赖图298→259（251registry+8path）；39包移除、0新增，Cargo.lock字节不变。真实默认库编译通过，15手写C ABI导出保留，UniFFI命名导出276→0。125项Vitest与3项Rust纯函数回归通过，typecheck/lint/architecture通过（301既有warnings）。

最终许可为13缺正文、1partial、0图内MPL；15条固定补充映射、431份索引材料和1份上游根正文已独立复核。licenses与productAdoption均blocked。未启动原生Driver、未调用系统输入、未变更证书/TCC、未启用产品。

- `report.json.gz`：最终带supplements的来源/依赖/工具链/许可审计，未再次请求build。
- `build-report.json.gz`、`build.log.gz`：同一候选源码的真实编译，未传supplements，其中28missing不是最终许可结论。
- `comparison.json`：固定第六轮报告到本轮最终审计的实际差额；`COMPARISON.md`为摘要。
- `acceptance-summary.json`：验证结果、制品摘要、config修正与源码一致关系。
- `licenses-index.json`与`licenses/`：带摘要的许可材料副本。
- `upstream-candidate.patch`：完整上游选定baseline到候选patch；round7目录另存历史候选到新候选的97,785B增量patch。
- `rust-tests.*`、`checks/`：controller真实检查日志。纯Rust测试只执行3个已审目标，不运行原生API。
- `symbol-verification.json`、`source-review-first.json`、`code-hashes.json`：符号与源增量/测试版本复核。
- `external-input-verification.json`、`prior-artifacts-verification.json`：16101历史输入与1175旧产物/代码文件不变。
- `evidence-sha256.json`：本目录其它证据的逐文件SHA-256索引。

build-script和proc-macro未受OS执行/网络沙箱约束；记录37个build-script-executed、16个proc-macro编译包，不用后者推导执行范围。SDK27.0/CLT只证明本机环境，最低macOS、Intel、签名/加载/TCC/peer/Fenced及D06仍未验收。功能继续默认禁用。
