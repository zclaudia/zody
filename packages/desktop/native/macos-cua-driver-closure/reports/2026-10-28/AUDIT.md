# 第六轮 Controller 验收归档

本轮可实施的缓存、固定工具链与编译审计完成；产品采用和许可门仍 **blocked**，默认禁用。总记录见 [第六轮计划](../../../../../../docs/plans/computer-use-macos-phase1-round6.md)。

- 原缓存：250目录缺Cargo.lock，原输入未修写。316锁定归档严格重建；macOS目标298包中的290个registry依赖核验通过。
- 独立Rust1.97.1：固定版本/commit/host/sysroot/二进制摘要匹配。默认stable、旧Helper pin未改动。
- 本机SDK编译：exit0，43个build-script事件、18个proc-macro编译包、319个产物；rlib/dylib实际保存并复核摘要。未运行候选应用/测试；未申请TCC或安装证书。HOME/CARGO_HOME隔离不等于OS sandbox。
- 许可：22包补充材料，488份正文/通知文件逐一核验。14包缺正文、2包partial、6个MPL义务待审；较新objc2根说明与Apple SDK关系独立待审，未作为完整正文计数。
- 9文件97tests、根typecheck、lint（301 warnings/0 errors）、architecture（0 violations）通过；定向lint/format通过。

## 证据

[acceptance-summary.json](acceptance-summary.json) 是两个独立审计的事实摘要，不改写原始门状态：

- `report.json.gz`：冻结后的完整来源/重建/工具链/许可审计；未请求编译。
- `build-report.json.gz`、`build.log.gz`：独立真实库编译审计；未请求许可补充材料。两次来源清单和patch摘要一致，无需因仅许可材料更新重复编译。
- `candidate-source.patch`：与第五轮固定来源差额相同，可重建752候选文件。
- `licenses-index.json`、`licenses/`：488份索引材料及单独上游根许可。notice不冒称body；许可正文识别是材料证据，不是法律结论。
- `platform-tool-versions.json`：只读CLT/Swift/macOS补证；xcodebuild因未选择完整Xcode而失败，原样记录。系统CLT/Swift尚未跨机器pin。
- `toolchain-preparation.json`、`channel-rust-1.97.1.toml`：显式独立工具链准备记录与官方发行清单。
- `original-input-hashes.json.gz`、`original-input-verification.json`：16101历史输入0修改/缺失/新增；`prior-artifacts-verification.json`确认583个旧文件未变。
- `audit-code-hashes.json`、`checks/`：controller最终审查代码摘要与实际校验日志。
- `license-*-controller.json`：controller独立固定commit取材/404记录。objc2四个固定源码归档许可命名文件枚举与notice在相邻[补充材料目录](../../license-supplements/README.md)。
- `evidence-sha256.json`：本目录所有其它文件的SHA-256。gzip均逐字节解压复核；不是产品签名或可信安装证明。

SDK大二进制保留于本机 `output/cua-driver-round6/controller-build-accepted/build-artifacts/`，不加入产品包或仓库发行产物；具体大小/摘要见摘要JSON。库编译成功不是原生Helper加载、签名、peer、TCC或Fenced验收。正式Driver裁剪、许可缺口、D06后续验证、Intel/最低macOS及原生链路继续按计划推进。
