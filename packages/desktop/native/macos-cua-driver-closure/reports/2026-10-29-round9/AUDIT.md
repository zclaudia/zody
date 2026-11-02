# Driver 依赖闭包审计结果

生成时间：2026-10-29T02:30:34.600Z

- 固定 upstream：`2d2f99228d4d2508dc6fcc84c176b296e146714a` (`libs/cua-driver/rust`)
- 来源审计：pass；710 个固定源文件，38 个冻结差额文件，66 个新增文件，776 个候选文件。
- 自包含 patch：`candidate-source.patch`，sha256 `b89dfcfba83667c31f2b8d5f553cb224d8ad66f51108c00d0c10acd7b526f0db`；应用后逐字节重建：pass。
- 原始 cache：blocked（checksum pass，source blocked）；重建 316 个包，pass。
- 锁定依赖：571 个 lock 条目；实际 macOS normal/build 图：20 个包，root `cua-macos-visual@0.37.0`。
- registry 缓存：19 个包完成 archive checksum 与解包源逐文件比对；状态 pass。
- 许可材料：20 个包；缺包级正文 0，待义务审查 0，部分材料覆盖 0；归档 44 个正文/通知文件。该结果仅为表达式/正文/哈希清单，不是法律结论。
- 工具链：声明 1.97.1，本机审计 1.97.1；explicit driver toolchain matches the fixed upstream declaration, commit, host and binary digests
- 编译证据：pass（build-library，build scripts 4，compiled proc-macro 0）。未启动上游应用或测试。

## Gates

| Gate | Status |
| --- | --- |
| source | pass |
| dependencies | pass |
| licenses | pass |
| toolchain | pass |
| build | pass |
| productAdoption | blocked |

退出码 `0` 仅表示已实现来源审计是否可完成/无验证失败；不表示产品闭包通过。本轮不是全产品验收。

## 阻断项

- originalCache (blocked)：original registry sources differ from their verified archives (including Cargo.lock)
- productAdoption (blocked)：closure audit never authorizes product adoption; native, signing, TCC and runtime evidence remain separate gates

完整逐文件哈希、特性、registry 包和许可材料见 `report.json`；许可正文位于 `licenses/`，索引见 `licenses-index.json`。本工具仅在显式请求时执行 Cargo 离线编译；不启动上游应用或测试、不申请 TCC，也不启用产品 CUA。


## 复跑

```sh
node packages/desktop/scripts/audit-macos-cua-driver-closure.mjs \
  --source-repo /Users/zhvala/SourceCode/3rd-party-repositories/cua \
  --candidate-root /Users/zhvala/SourceCode/zody/output/cua-driver-round9/candidate-work/controller-final/full-source \
  --cargo-home /Users/zhvala/SourceCode/scripts/experiments/zody-cua-p0-g2-stop-retire-reservation/build/cargo-home \
  --output-dir /Users/zhvala/SourceCode/zody/output/cua-driver-round9/controller-final-audit \
  --rebuild-cache \
  --toolchain-root /Users/zhvala/SourceCode/zody/output/cua-driver-round6/rustup/toolchains/1.97.1-aarch64-apple-darwin \
  --build-library
```

`exit 0` 只确认来源审计完成且无验证失败；依赖、许可、工具链、编译和产品采用门禁可能仍为 blocked。原始 cache 漂移、目标图归档缺失和工具链漂移均 fail-closed。
