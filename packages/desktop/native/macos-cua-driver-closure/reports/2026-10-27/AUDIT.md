# Driver 依赖闭包审计结果

生成时间：2026-10-27T15:21:26.245Z

- 固定 upstream：`2d2f99228d4d2508dc6fcc84c176b296e146714a` (`libs/cua-driver/rust`)
- 来源审计：pass；710 个固定源文件，23 个冻结差额文件，42 个新增文件，752 个候选文件。
- 自包含 patch：`candidate-source.patch`，sha256 `a4e1da2751e2449317e906dde99798c73b3ebf826a6e00fecc413ebbc23f93f0`；应用后逐字节重建：pass。
- 锁定依赖：569 个 lock 条目；实际 macOS normal/build 图：298 个包，root `cua-driver-sdk@0.37.0`。
- registry 缓存：0 个包完成 archive checksum 与解包源逐文件比对；状态 blocked。
- 许可材料：298 个包；缺包级正文 33，待义务审查 6；归档 485 个正文/通知文件。该结果仅为表达式/正文/哈希清单，不是法律结论。
- 工具链：声明 1.97.1，本机审计 1.93.1；audited toolchain differs from the upstream declaration; no closure claim is made

## Gates

| Gate | Status |
| --- | --- |
| source | pass |
| dependencies | blocked |
| licenses | blocked |
| toolchain | blocked |
| productAdoption | blocked |

退出码 `0` 仅表示已实现来源审计是否可完成/无验证失败；不表示产品闭包通过。本轮不是全产品验收。

## 阻断项

- dependencies (blocked)：cached source verification failed: adler2@2.0.1: source does not match archive (missing=Cargo.lock)
- licenses (blocked)：33 packages lack package-level material (workspace-root relation may be pending); 6 require license review
- toolchain (blocked)：audited toolchain differs from the upstream declaration; no closure claim is made
- productAdoption (blocked)：round-5 closure audit never authorizes product adoption; native, signing, TCC and runtime evidence remain separate gates

完整逐文件哈希、特性、registry 包和许可材料见 `report.json`；许可正文位于 `licenses/`，索引见 `licenses-index.json`。本工具不编译、不执行上游程序、不下载依赖、不申请 TCC，也不启用产品 CUA。


## 复跑

```sh
node packages/desktop/scripts/audit-macos-cua-driver-closure.mjs \
  --source-repo /Users/zhvala/SourceCode/3rd-party-repositories/cua \
  --candidate-root /Users/zhvala/SourceCode/scripts/experiments/zody-cua-p0-g2-stop-retire-reservation/full-source \
  --cargo-home /Users/zhvala/SourceCode/scripts/experiments/zody-cua-p0-g2-stop-retire-reservation/build/cargo-home \
  --output-dir packages/desktop/native/macos-cua-driver-closure/reports/2026-10-27
```

`exit 0` 只确认来源审计完成且无验证失败；依赖、许可、工具链和产品采用门禁可能仍为 blocked。registry 缓存逐文件漂移会以 blocked 记录，不会被豁免或改写为通过。
