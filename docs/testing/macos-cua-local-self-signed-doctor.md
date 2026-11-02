# macOS 自签名 CUA Helper 只读诊断合同

状态：R2-S 开发合同。适用 profile：`local-self-signed`。本诊断只核对指定 `.app` 与本地 profile 的静态一致性和签名身份，不启动 Helper，不调用 Keychain、TCC、`spctl` 或 `stapler`，不生成或修改证书，也不读取私钥。通过本诊断不等于 Helper 加载、peer 校验、TCC 主体、冷启动、覆盖升级或系统输入验收通过。

产品规则来源：`specs/computer-use-macos-phase1.md` 的“当前签名策略（2026-10-26）”。示例身份固定为 `io.github.zclaudia.zody.cua-helper`，不继承旧 ZCode/上游 Team 标识；自签名 profile 不要求 Apple Team ID，`TeamIdentifier=not set` 不是失败。

## 1. CLI 合同

```bash
node scripts/doctor-macos-cua-helper-local.mjs \
  --app /absolute/path/to/Zody\ Computer\ Use.app \
  --profile /absolute/path/to/cua-helper-local-self-signed.json \
  --json
```

- `--app` 与 `--profile` 必填，且必须是绝对路径。相对路径、空值、未知参数、重复参数和位置参数按 `input.arguments` 失败返回。
- `--json` 输出结构化结果；省略时输出人类可读的逐项结果。
- 退出码：`0` 通过；`1` 失败；`2` 被阻断或参数错误。
- 所有外部命令都通过 `execFile` 参数数组调用固定系统命令，不使用 shell 字符串、不拼接用户输入。

结构化结果：

```json
{
  "schemaVersion": 1,
  "kind": "macos-cua-helper-local-doctor",
  "status": "pass | blocked | fail",
  "appPath": "/absolute/path/to/App.app",
  "profilePath": "/absolute/path/to/profile.json",
  "profile": "local-self-signed",
  "checks": [{ "id": "platform.macos", "status": "pass", "message": "running on macOS" }],
  "summary": { "pass": 1, "fail": 0, "blocked": 0 }
}
```

总体状态优先级：任一 `fail` 为 `fail`；否则任一 `blocked` 为 `blocked`；全部 `pass` 才为 `pass`。`blocked` 表示缺少产物、必需工具或 profile 待填值，不能当作通过；`fail` 表示产物、签名或身份与 profile 不一致。

## 2. Profile 合同

示例文件：`config/cua-helper-local-self-signed.example.json`。所有字段必填，未知字段直接失败；空字符串、空数组和空指纹属于待填写项，输出 `blocked`，不能生成通过结果。

| 字段                    | 类型     | 规则                                                                                                                                                                                         |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`         | number   | 必须为 `1`                                                                                                                                                                                   |
| `profile`               | string   | 必须为 `local-self-signed`                                                                                                                                                                   |
| `bundleId`              | string   | 非空；禁止历史 `dev.zcode` 身份；示例为 `io.github.zclaudia.zody.cua-helper`                                                                                                                 |
| `executableName`        | string   | 非空；只能是 `Contents/MacOS/` 下的单段文件名                                                                                                                                                |
| `bundleShortVersion`    | string   | 非空；数字点分版本，必须与 `CFBundleShortVersionString` 完全一致                                                                                                                             |
| `bundleVersion`         | string   | 非空；数字点分版本，必须与 `CFBundleVersion` 完全一致                                                                                                                                        |
| `architectures`         | string[] | 非空；仅允许 `arm64`、`arm64e`、`x86_64`，不得重复；示例同时冻结 `arm64` 与 `x86_64`                                                                                                         |
| `minimumMacOSVersion`   | string   | 非空；每个实际架构的 `minos` 都必须等于该值                                                                                                                                                  |
| `leafCertificateSha256` | string   | 非空时必须是 64 位十六进制；表示签名证书叶的 DER SHA-256                                                                                                                                     |
| `designatedRequirement` | string   | 非空；只接受窄语法 `identifier "<bundleId>" and certificate leaf = H"<40-hex SHA-1>"`，identifier 必须等于 profile `bundleId`；H 值必须等于实际抽取证书叶的 SHA-1；另用独立 SHA-256 pin 校验 |
| `executableSha256`      | string   | 非空时必须是 64 位十六进制；表示 `Contents/MacOS/<executableName>` 的文件 SHA-256                                                                                                            |
| `entitlements`          | object   | 必填对象；实际 entitlements 必须与该对象精确相等；静态 Rust Helper 默认 `{}`                                                                                                                 |

禁止的 entitlements（即使 profile 显式写入也失败）：

- `com.apple.security.cs.disable-library-validation`
- `com.apple.security.cs.allow-dyld-environment-variables`

旧 Node Helper 的 JIT/unsigned executable memory/get-task-allow 等宽权限不能自动继承；profile 为 `{}` 时，实际多出任何键都失败。

输入边界：profile 文件上限 1 MiB；entitlements 递归深度上限 32、节点上限 2048；版本号的每一段必须是安全整数。`CFBundleExecutable` 只能是单段文件名，Info.plist 与可执行文件都必须 realpath 后仍位于 `.app` 内，禁止通过绝对路径、`..` 或 symlink 逃逸。

## 3. 检查项与证据

| Check id                           | 通过条件                                                                                                                                                                               | 失败/阻断条件                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `platform.macos`                   | `process.platform === "darwin"`                                                                                                                                                        | 非 macOS 直接 `blocked`，不执行任何命令                                                |
| `input.arguments`                  | `--app`、`--profile` 为绝对路径且无 NUL                                                                                                                                                | 相对路径、空值等 `fail`                                                                |
| `profile.file`                     | profile 可异步读取                                                                                                                                                                     | 缺失或不可读 `blocked`                                                                 |
| `profile.schema`                   | JSON 对象、字段类型/取值/未知字段校验通过                                                                                                                                              | 类型错误、未知字段（含 `teamId`）`fail`                                                |
| `profile.required-values`          | 必填值均非空                                                                                                                                                                           | 任一待填值 `blocked`，并列出字段                                                       |
| `profile.identity-policy`          | bundle ID 非历史身份；DR 固定 identifier 与 certificate leaf；profile 无禁止 entitlements                                                                                              | 违反策略 `fail`                                                                        |
| `app.bundle`                       | `.app` 目录存在                                                                                                                                                                        | 缺失 `blocked`                                                                         |
| `app.info-plist`                   | `plutil -convert json -o - -- <Info.plist>` 成功且为对象                                                                                                                               | 工具缺失 `blocked`；解析失败 `fail`                                                    |
| `app.bundle-identity`              | bundle ID、可执行名、短版本、构建版本与 profile 完全一致                                                                                                                               | 任一不一致 `fail`；待填字段 `blocked`                                                  |
| `app.executable`                   | `Contents/MacOS/<CFBundleExecutable>` 是文件                                                                                                                                           | 缺失 `blocked`                                                                         |
| `signature.verify`                 | `codesign --verify --deep --strict --verbose=2 <app>` 成功                                                                                                                             | 工具缺失 `blocked`；签名无效 `fail`                                                    |
| `signature.authority`              | `codesign -d --verbose=4 <app>` 无 `Signature=adhoc`，且存在真实 `Authority=`                                                                                                          | ad-hoc/无证书 `fail`；工具缺失 `blocked`                                               |
| `signature.leaf-certificate`       | `codesign -d --extract-certificates=<temp>/cert <app>` 写出 `cert0`，可被 `crypto.X509Certificate` 解析                                                                                | 提取/解析失败 `fail`；工具缺失 `blocked`                                               |
| `signature.leaf-sha256`            | 证书叶 DER SHA-256 等于 profile                                                                                                                                                        | 待填 `blocked`；不一致 `fail`                                                          |
| `signature.designated-requirement` | artifact 内嵌 DR 与 profile DR 都通过窄语法解析；两者 identifier 均等于 bundleId、leaf H 值相同；抽取证书叶 SHA-1 等于该 H 值；`codesign --verify --strict -R=<profile DR> <app>` 成功 | 待填/证书叶不可得 `blocked`；任一 DR 语法、身份或 SHA-1 不等价，或 `-R=` 不满足 `fail` |
| `signature.entitlements`           | 实际 entitlements 与 profile 精确相等                                                                                                                                                  | 读取/解析失败 `fail`；不一致 `fail`                                                    |
| `signature.entitlements-policy`    | 实际与 profile 均无禁止键                                                                                                                                                              | 出现禁止键 `fail`                                                                      |
| `binary.architectures`             | `lipo -archs <exe>` 集合等于 profile                                                                                                                                                   | 待填 `blocked`；不一致 `fail`                                                          |
| `binary.minimum-macos`             | `otool -arch all -l <exe>` 中每个实际架构 `minos` 等于 profile                                                                                                                         | 待填 `blocked`；解析失败或不一致 `fail`                                                |
| `binary.executable-sha256`         | 异步计算的 executable SHA-256 等于 profile                                                                                                                                             | 待填 `blocked`；不一致 `fail`                                                          |
| `doctor.cleanup`                   | 专用临时目录删除成功                                                                                                                                                                   | 删除失败 `fail`                                                                        |

## 4. 命令和解析证据

- 固定系统命令为 `/usr/bin/codesign`、`/usr/bin/lipo`、`/usr/bin/otool`、`/usr/bin/plutil`；真实 adapter 不按 `PATH` 解析裸命令名，测试通过注入 adapter 提供合成结果。
- `codesign --verify --deep --strict --verbose=2 <app>` 验证签名完整性；不调用 `spctl` 或 `stapler`。
- `codesign -d --verbose=4 <app>` 读取 `Authority=`、`Signature=adhoc`、`TeamIdentifier=`；该命令常把诊断写到 stderr，代码合并 stdout 与 stderr 后解析。不把任意证书名或 `TeamIdentifier=not set` 当身份证明。
- `codesign -d --extract-certificates=<dedicated-temp>/cert <app>`：本机 `man codesign` 明确“Certificate 0 is the leaf (signing) certificate”，文件为 ASN.1 DER；随后用 `crypto.X509Certificate` 的 DER 原始字节计算 SHA-1（窄 DR 交叉校验）与 SHA-256（独立 pin）。真实命令验证显示分离形式 `--extract-certificates <prefix> <app>` 会把 prefix 当作待验 app 并以 `No such file or directory` 失败；等号单参数形式 `--extract-certificates=<prefix>` 才写出 `prefix0`，代码固定使用等号形式。
- `codesign -d -r- <app>` 输出也常在 stderr；代码合并 stdout 与 stderr 后解析实际 DR。artifact 内嵌 DR 必须本身是窄语法并固定 bundleId 与证书叶 SHA-1；仅靠外层 `-R=` 满足要求不足以证明未来身份连续性。随后再用 `codesign --verify --strict -R=<profile DR> <app>` 验证 artifact 满足 profile 要求。不把字符串包含、`or`、`true` 或额外放宽条件当通过证据。本机验证 `-R=<requirement>` 单参数形式可用；`--test-requirement` 分离参数在当前 macOS 26.6.2 / Darwin 25.6.0 上被当作路径，故代码固定使用 `-R=<requirement>`。
- `codesign -d --entitlements - --xml <app>` 的 entitlement plist 从 stdout 读取；诊断/warning 可出现在 stderr，不混入 plist。写入专用临时文件后经 `plutil -convert json -o - -- <file>` 解析；空 stdout 按 `{}` 处理。
- `lipo -archs <exe>` 读取实际架构集合；`otool -arch all -l <exe>` 解析 `LC_BUILD_VERSION`（`platform 1`）或 `LC_VERSION_MIN_MACOSX` 的 `minos`/`version`，按 `(architecture ...)` 分段匹配。
- `plutil -convert json -o - -- <Info.plist>` 解析 Info.plist。
- 临时目录仅用于证书提取和 entitlements 转换，结束时递归删除；不读取私钥、不写 Keychain。

证据限制：以上结论来自本机 `man codesign`、`man lipo`、`man otool`、`man plutil` 和本机命令行为（macOS 26.6.2 / Darwin 25.6.0）。网络受限，未在本轮抓取 Apple 在线文档；不同 macOS 版本的 `codesign` 输出措辞可能变化，解析失败会 fail-closed。静态检查不能证明 Helper 可加载、peer 身份、TCC 授权、冷启动或升级连续性；这些仍需最终签名 Helper 的原生验收。

## 5. 验收用例

测试入口：`packages/desktop/test/macosCuaHelperLocalSelfSignedDoctor.test.ts`。使用可注入命令 adapter 和合成 fixture，不依赖本机真实 Helper 或证书。

| 用例                                                                         | 期望                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 非 macOS                                                                     | `blocked`，adapter 零调用                                          |
| 完整合成 fixture                                                             | `pass`；命令参数数组准确；临时目录清理                             |
| 示例 profile 空指纹/空摘要/空 DR/空最低 OS                                   | `blocked`；相关 check 不得 pass                                    |
| ad-hoc 签名                                                                  | `fail`；`signature.authority` 与 `signature.leaf-certificate` 失败 |
| 证书叶 SHA-256 不匹配                                                        | `fail`；`signature.leaf-sha256` 失败                               |
| profile DR 与实际签名不匹配                                                  | `fail`；`signature.designated-requirement` 失败                    |
| DR 只写 identifier、不固定 certificate leaf                                  | `fail`；`profile.identity-policy` 失败                             |
| DR 使用 `or`、`true`、额外 `and` 或 identifier 与 bundleId 不一致            | `fail`；窄语法解析拒绝，`profile.identity-policy` 失败             |
| DR 语法正确但 H 的 40 位 SHA-1 与实际证书叶不一致                            | `fail`；`signature.designated-requirement` 失败                    |
| artifact 内嵌 DR 只有 identifier、只有 cdhash 或与 profile leaf SHA-1 不等价 | `fail`；即使外层 `-R=` 正确也不得通过                              |
| Info.plist bundle ID / executable / 短版本 / 构建版本任一不一致              | `fail`；`app.bundle-identity` 失败                                 |
| 架构集合或每架构最低 OS 不一致                                               | `fail`；对应 binary check 失败                                     |
| executable SHA-256 不一致                                                    | `fail`；`binary.executable-sha256` 失败                            |
| 旧 Node JIT/宽 entitlements 对空 profile                                     | `fail`；精确集合与禁止键检查失败                                   |
| profile 显式冻结禁止 entitlements                                            | `fail`；`profile.identity-policy` 与 policy check 失败             |
| 必需工具缺失                                                                 | `blocked`，不是 `fail`                                             |
| `.app` 或 Info.plist 缺失                                                    | `blocked`                                                          |
| JSON 含 `teamId`                                                             | `fail`，提示自签名 profile 不要求 Apple Team ID                    |
| 路径含 shell 元字符                                                          | 作为单个 argv 传递，不触发 shell                                   |
| `CFBundleExecutable` 或 Info.plist symlink 指向 `.app` 外                    | `fail`；realpath containment 拒绝                                  |
| 版本号超过安全整数、profile 超大或 entitlements 过深/过多                    | `fail` 或 `blocked`；有界校验拒绝，不发生递归溢出                  |
| codesign display/DR 在 stderr、entitlements 在 stdout                        | 真实输出布局仍能通过；不得依赖全部放在 stdout 的 fake              |
| `--app --profile --json`                                                     | JSON 可解析，退出码与状态一致                                      |

## 6. 本机非 mock 复验（2026-10-26）

- 真实 CLI 对 `packages/desktop/dist/mac-arm64/Zody.app` 运行：`node scripts/doctor-macos-cua-helper-local.mjs --app <abs app> --profile /private/tmp/zody-r2-doctor-real-profile.json --json`，退出码 `1`，状态 `fail`（16 pass / 4 fail / 1 blocked）。`signature.verify` 报签名与资源不一致，`signature.authority` 识别为 ad-hoc，`signature.leaf-certificate` 因无可提取证书失败，`signature.designated-requirement` 明确拒绝 `cdhash H"..."` 内嵌 DR；`binary.minimum-macos`、`binary.executable-sha256`、`doctor.cleanup` 通过。
- 真实 ad-hoc app 的 `codesign -d -r-` 输出（stderr）为 `cdhash H"35d594ff563992e91b0cf727f1aa77bd5fb1e7f9"`；doctor 明确不把这种内嵌 DR 当窄身份约束，未产生 pass。
- `codesign -d --extract-certificates <prefix> <app>` 在本机以 prefix 被当作 app 失败（`No such file or directory`）；`--extract-certificates=<prefix>` 等号形式被接受。本机 `/bin/ls` 和若干已签名 app 的 `Authority=(unavailable)`，实测未写出 `cert0`，因此证书正路径由合成 fixture 覆盖；最终自签名 Helper 的真实正路径仍需在证书产物存在后复验。

## 7. 非目标

- 不启动、加载或探测 Helper 进程。
- 不调用 `spctl`、`stapler`、TCC 数据库、Keychain 或安全工具修改命令。
- 不生成、导入、信任或删除证书，不读取私钥。
- 不把 `codesign --verify` 通过解释为 Gatekeeper、公证、TCC 或运行时权限通过。
- 不修改 `.app`、profile 或仓库内其他文件。
