# 第八轮 controller 验收记录

开始2026-10-28；最终验收2026-10-29。DeepSeek实现，controller独立审查、重新构建和验证。完整范围、worker台账与下一阶段顺序见[第八轮计划](../../../../../../docs/plans/computer-use-macos-phase1-round8.md)。

## 结果

- 最终树 `4cbad8776947504f9883bf5370d6802177090d7a01075c5640b64a730950d9de`，767文件。冻结R7的753路径保留，仅根Cargo.toml/Cargo.lock改变，新增14文件。增量patch与清单在`frozen-inputs/`。
- 实际目标图SDK259→视觉30（29registry+1path），230移出、1新增、9项feature变化。新根非SDK功能/ABI等价替换；旧SDK/core/platform不在新构建图，源码保留。
- 新图许可正文0missing/0partial/0reviewRequired/0MPL，62份包内材料及upstream根许可已归档。旧图13missing/1partial仅移出该图，没有被补齐。无补充映射；不是法律结论。
- 固定Rust1.97.1工具链，arm64 locked/offline真实库构建通过；8个build-script包、0proc-macro、30项产物记录。316归档重建、29目标registry核验通过。原缓存仍blocked，未更改。
- 最终树32项纯Rust测试（16单元+16集成）通过；两个Mach-O程序真实链接、启动，已确认系统Swift rpath。测试不调用窗口枚举、截图或输入。
- 87项Driver工具测试、pnpm typecheck、pnpm lint（301 warnings/0 errors）、architecture:check --changed（0violations）通过。定向11文件Lint/格式与固定rustfmt通过。全仓类型/行数历史失败未复现。
- 原实验16101文件、R7归档457文件摘要保持。默认禁用，zcodeCuaPlaceholder仍true。未安装证书或更改系统权限。

## 证据目录

`report.json.gz`是完整最终审计原始JSON；`AUDIT.md`、`build.log.gz`记录编译。`upstream-candidate.patch`是完整固定上游→R8补丁，和`frozen-inputs/candidate-source.patch`（R7→R8）不同，不应混用。rlib本次摘要见acceptance-summary，二进制保留在本地output，不纳入此文本归档。

`comparison.json`/`COMPARISON.md`明确换根与功能缩减。`licenses-index.json`和`licenses/`保存精确许可文本。`rust-tests/`是最终树测试；`intermediate-semantic-tree-tests/`只为历史中间树证据。`failed-attempts/`保留SCK特性不足、Swift兼容库链接失败和dyld启动前失败，不能计为通过。`checks/rust-format.log`为中间格式失败，最终结果是`rust-format-accepted.log`。

`checks/`还含全仓/定向测试、源码与锁文件检查、原输入/R7证据保留、两个测试Mach-O的otool记录和并行无关改动登记。所有证据文件由`evidence-sha256.json`绑定。报告中原始绝对路径/时间保持，未为归档改写审计结果。

## 复跑

从仓库根以mise规定Node24.14.0执行prepare入口，选择未存在的`output/cua-driver-round8/candidate-work/<name>/full-source`。审计命令须显式传入：

```sh
node packages/desktop/scripts/audit-macos-cua-driver-closure.mjs \
  --source-repo /Users/zhvala/SourceCode/3rd-party-repositories/cua \
  --candidate-root /Users/zhvala/SourceCode/zody/output/cua-driver-round8/candidate-work/controller-accepted/full-source \
  --cargo-home /Users/zhvala/SourceCode/scripts/experiments/zody-cua-p0-g2-stop-retire-reservation/build/cargo-home \
  --output-dir /Users/zhvala/SourceCode/zody/output/cua-driver-round8/replay-audit \
  --review-config packages/desktop/native/macos-cua-driver-closure/round8/review-config.json \
  --source-manifest packages/desktop/native/macos-cua-driver-closure/round8/source-manifest.json \
  --rebuild-cache \
  --toolchain-root /Users/zhvala/SourceCode/zody/output/cua-driver-round6/rustup/toolchains/1.97.1-aarch64-apple-darwin \
  --build-library
```

纯测试runner的实际命令/隔离环境保存在`rust-tests/controller-runner.mjs.txt`；复跑须换未存在输出目录。该环境不是OS sandbox。只执行所列纯测试，不运行上游全部原生测试。

## 不升级的结论

SCK内部Swift/Metal/录屏耦合未完全裁剪；未来Helper最终消费者必须自行闭合链接/rpath。内部采集缺可信许可生命周期及有界取消，当前公开请求仍HostNotApproved。CG事实不是进程incarnation/前台/display身份，不发布finalFrame。真实截图、Helper/TCC/签名/peer/升级、Fenced/手机屏障和完整D06未验收。Intel、最低macOS、Retina/多显示器缺环境。产品采用仍blocked。
