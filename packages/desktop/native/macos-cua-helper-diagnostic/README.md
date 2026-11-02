# Zody Computer Use Diagnostic Helper

状态：R4-H 诊断构建合同。该制品仅用于构建、进程与退出状态诊断，不是可输入的产品 Helper。

## 产品边界

- 名称：`Zody Computer Use Diagnostic`
- Bundle ID：`io.github.zclaudia.zody.cua-helper-diagnostic`
- 唯一构建目标：`arm64-apple-macos12.0`；12.0 是构建目标，不是已验收的运行时最低版本。
- 源码与 Rust 标准库使用：Apache-2.0 / 标准库 `Apache-2.0 OR MIT`，具体文件与摘要写入 manifest。
- 不链接 Computer Use Driver，不包含输入、截图、peer 认证、TCC、证书、钥匙串或网络能力。
- 不接默认构建、安装、launcher、runtime 授权或旧 doctor。输出根固定为
  `output/cua-helper-diagnostic/darwin-arm64`，由仓库 `.gitignore` 忽略。

## 进程合同

每次进程只接受一个参数，且只执行一次诊断：

| 参数                       | 行为                   | 退出码 |
| -------------------------- | ---------------------- | ------ |
| `--health`                 | 输出单行 JSON 健康事实 | 0      |
| `--help`                   | 输出固定帮助文本       | 0      |
| `--version`                | 输出固定版本           | 0      |
| 无参数、未知参数或多余参数 | 输出固定错误文本       | 2      |

进程不读取 stdin，不创建 socket/网络连接，不读写应用文件，不启动子进程，不请求系统输入或 TCC。
错误路径不回显未信任参数或环境值。`--health` 必须明确：

- `inputCapable=false`
- `driverLinked=false`
- `tccRequested=false`
- `nativeCapabilityProven=false`

上述字段只是诊断声明，不能证明原生输入能力、签名身份、TCC 授权或 Driver 兼容性。

## 构建合同

唯一入口：

```sh
node packages/desktop/scripts/build-macos-cua-helper-diagnostic.mjs
```

构建脚本先在 PATH 中显式选择已安装工具链并设置 `RUSTUP_AUTO_INSTALL=0`，然后从实际 sysroot
解析真实的 `rustc`、`cargo` 路径；后续构建不经过 rustup 代理。Rust/Cargo 必须精确匹配：

- `rustc 1.93.1` / commit `01f6ddf7588f42ae2d7eb0a2f21d44e8e96674cf`
- `cargo 1.93.1` / commit `083ac5135f967fd9dc906ab057a2315861c7a80d`

`rust-toolchain.toml` 固定该版本；由于本机安装名可能是 `stable`，可通过
`--rust-toolchain stable` 显式选择，但版本与 commit 校验不放松。不会自动安装、更新或下载工具链。

Cargo 执行 `--locked --offline`。构建源码复制到系统临时目录，cwd 与 manifest 均不使用仓库
祖先；构建前逐级检查 cwd 到根目录的 `.cargo/config{,.toml}`，发现任一配置或 `.cargo`
符号链接即失败，并把检查目录数与空结果写入 manifest。`CARGO_HOME` 指向临时空目录，且只传
白名单环境变量。
`RUSTFLAGS`、`RUSTC_WRAPPER`、`RUSTC_WORKSPACE_WRAPPER`、`CARGO_ENCODED_RUSTFLAGS`、
`CARGO_BUILD_RUSTFLAGS`、外部 `RUSTC`/`CARGO_TARGET_DIR` 等不会进入构建。子进程有超时与输出上限。

构建先在输出目录旁建立 staging，完成全部校验后才替换 `darwin-arm64`。既有产物在编译、检查或
manifest 生成失败时保持不变。输出目录、app、Info、可执行文件及资源路径出现符号链接时拒绝构建。

## 制品与 manifest

```text
output/cua-helper-diagnostic/darwin-arm64/
  Zody Computer Use Diagnostic.app/
    Contents/Info.plist
    Contents/MacOS/Zody Computer Use Diagnostic
    Contents/Resources/LICENSE
    Contents/Resources/COPYRIGHT-library.html
  manifest.json
```

`manifest.json` 的 `kind` 为 `zody-cua-helper-diagnostic-manifest`，记录：

- 固定源码、`Cargo.lock`、Info、根 LICENSE 与标准库许可文件的 SHA-256；
- 实际 rustc/cargo 版本、commit、host、sysroot 与 `COPYRIGHT-library.html` 摘要；
- SDK 路径/版本、构建目标与显式参数、隔离 `CARGO_HOME`、minos；
- 实际 Mach-O 架构、minos、动态库依赖、crate 依赖树；
- 二进制/Info/许可文件摘要、`driverLinked=false` 与诊断能力声明；
- 二进制与 `.app` 的实际只读签名探测结果；
- 与 upstream 声明 Rust `1.97.1` 的差额：本诊断骨架使用 1.93.1，未纳入 Driver 源码、patch
  或完整许可闭包。

签名只做 `codesign --verify/--display` 读取。arm64 linker 可能产生 ad-hoc 签名，manifest 必须
如实记录 `adhoc`、`unsigned`、实际 Authority、Team ID、CDHash 与验证结果；验证器会逐字段
复核实际签名事实。不会归类为 `local-self-signed`，也不执行 `codesign --sign`、改证书、
钥匙串或 TCC。`verified=false` 只表示当前未签名身份门槛未通过，不会被 smoke 解释为通过。

## 验证合同

验证器先从固定制品根读取并校验 manifest schema、实际 `.app`/Info、BOM 名称、bundle ID、
源文件与许可摘要、可执行文件摘要、架构、minos、依赖、签名事实及 `driverLinked=false`。
可执行文件路径只能由实际 Info 的单个 `CFBundleExecutable` 组件推导，并与 manifest 的相对路径
一致；绝不把 manifest 中的路径当作任意 spawn 目标。

只有上述检查全部通过，才直接 spawn 由实际 Info 推导的可执行文件，验证：

- `--health` 退出 0，JSON 字段满足诊断合同；
- `--help`、`--version` 退出 0；
- 无参数、未知参数、`--health` 加多余参数退出 2；
- 错误输出不回显传入的 canary。

任何缺失、schema 错误、摘要变化、路径/符号链接异常、架构/minos 不符或签名事实不符都会在 spawn
之前失败。真实 smoke：

```sh
node packages/desktop/scripts/test-macos-cua-helper-diagnostic.mjs
```

smoke 的 `status=pass` 只表示诊断构建/摘要/进程合同通过；`signatureIdentityVerified` 根据
实际 `codesign` 结果单独给出，当前 ad-hoc 产物的未签名门槛不会被扩写成签名通过。

## 失败与限制

- 非 macOS/非 arm64、缺少 xcrun/SDK、已安装工具链缺失或版本/commit 不符：`blocked`，退出 2。
- 编译失败、签名/摘要/架构/minos/进程合同不符：失败，退出 1。
- 该制品不证明原生输入、TCC、Driver、peer、D06 隔离、Intel、最低 macOS 实机或发布签名已验收。
- 真实产物依赖 controller 运行 smoke；本目录不提供默认构建或运行接线。
