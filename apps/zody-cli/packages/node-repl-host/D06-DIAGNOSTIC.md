# node_repl cell D06 显式诊断工具

状态：候选诊断，默认不接线，不翻转产品 executor；完整 D06 门固定为 `blocked`。
R4 入口覆盖 fork/seatbelt 矩阵与 R4-07 启动拒绝反例；独立 R5 入口覆盖原生/FFI 探针、
临时 Browser client、资源完整性、直接 cell abort 和 debugger 状态门。两者都不代表正式
OS 隔离、签名 Helper、真实 Browser、TCC/输入权限或 SEA 已验收。

2026-10-27 controller 本机最终实跑：17/17 主矩阵与 2/2 R4-07 启动失败反例通过，exit 0，
`cleanup.removed = true`；证据保存在 `/tmp/zody-cua-r4-d06-final.json`。该结果只关闭本工具
已实现的矩阵，`d06Gate` 仍固定为 `blocked`。

2026-10-27 Round 5 首次 controller 实跑为 `/tmp/zody-cua-r5-d06-second.json`，除 FFI 控制写
外其余已实现 case 通过，debugger 按环境 blocked。该次失败来自 Darwin `open` 未带
`O_TRUNC`：13 字节 payload 写入旧的 18 字节 canary 后留下尾部。修复后 controller 第三跑为
7 passed / 0 failed / 1 blocked（debugger；本机 Developer mode disabled），exit 2，完整 D06
仍为 blocked。worker 自身入口在隔离环境被 synthetic Unix socket `listen EPERM` 阻断，证据为
`/tmp/zody-cua-r5-d06-third.json`（无 case 执行、cleanup 完成）；冻结代码由 controller 最终独立重跑。

## 入口与退出码

```bash
cd apps/zody-cli/packages/node-repl-host
PATH=/Users/zhvala/.local/share/fnm/node-versions/v24.14.0/installation/bin:$PATH \
  node --import tsx scripts/d06-diagnostic.ts > /tmp/zody-cua-r4-d06.json
```

也可执行 `pnpm --dir apps/zody-cli/packages/node-repl-host d06:diagnostic`。脚本只接受显式
`--node <path>` 选择固定 Node 24.14.0；没有新增环境变量开关。普通 `test` 只运行纯配置/判定
测试，不运行长时间真实诊断。

Round 5 使用保持 R4 可复跑的独立入口：

```bash
cd apps/zody-cli/packages/node-repl-host
PATH=/Users/zhvala/.local/share/fnm/node-versions/v24.14.0/installation/bin:$PATH \
  node --import tsx scripts/d06-round5.ts \
  --node /Users/zhvala/.local/share/fnm/node-versions/v24.14.0/installation/bin/node \
  > /tmp/zody-cua-r5-d06.json
```

也可执行 `pnpm --dir apps/zody-cli/packages/node-repl-host d06:round5`；需要固定运行时仍应显式
传 `--node`。Round 5 的 `exit 0/1/2` 分别表示已实现矩阵 satisfied、failed、blocked，任何
结果都保留 `d06Gate: "blocked"`。

- `exit 0`：主矩阵所有已实现 case 与 R4-07 failureTests 都满足预期；`d06Gate` 仍为
  `blocked`。
- `exit 1`：实际执行失败、未知错误或反例失败。
- `exit 2`：工具/策略/环境前置条件 blocked，例如无法加载 seatbelt 或无法创建临时 socket。

缺失工具、策略加载失败和启动拒绝都不触发无隔离重试。预期启动拒绝的成功记录在
`failureTests`，不会写成 D06 case blocked。

## 所有者与顺序

```text
CLI script -> temp canary/profile/bundle -> fork baseline
           -> R4-07 corrupted/missing launcher rejection
           -> same-profile policy load probe
           -> seatbelt cell matrix -> machine-readable evidence -> cleanup
```

脚本独占临时目录中的 bundle、profile、canary、fixture socket 和子进程；不读取真实凭据，
不连接真实服务，不安装签名/证书，不请求 TCC。所有 socket、child 和临时目录在 `finally`
清理，证据中记录 `cleanup.removed`。

## 主矩阵（17 项）

fork baseline（无 OS sandbox，仅用于证明候选执行器反例）：

- 可信 canary 读写实际发生。
- 动态 import 成功。
- 子进程短命退出并被回收。
- 合成的 ZCODE/AWS/NODE_OPTIONS 父环境不进入 cell。
- 父进程额外 canary FD 不继承；只接受 child `EBADF`，或 child `fstat` 的 dev+ino
  与父 canary 不同，不接受任意结构化错误。

seatbelt 候选（`deny default`）：

- 真实 built cell 健康执行、Node 版本/cwd/argv 可核验、直接子进程已退出。
- canary 读、写、动态 import 拒绝；写后文件 hash 不变。
- 精确允许的 synthetic docs/client 可读、可 import，写被拒绝且文件不变。
- TCP 与额外 Unix socket 拒绝，fixture 接受连接计数必须为 0。
- Browser fixture 只允许精确 synthetic Unix socket；fixture 校验 token、请求 schema 与
  `list` 方法并计数，明确不是真实浏览器。
- inspector 监听拒绝由**同一最终 profile 下独立真实 Node 进程**捕获 stderr
  `Operation not permitted` 且 URL 缺失；不宣称该证据经过 cell loader。
- 任意 `/usr/bin/true` 子进程启动被拒绝；同步 `spawn EPERM` 也纳入结构化判定。
- 无法归因的原始错误（例如全局 `ERR_MODULE_NOT_FOUND`、SyntaxError）不算拒绝。

canary dynamic import 的定向归因要求同时满足：同路径 `fs` 读取为 EPERM/EACCES、
canary 存在且前后 SHA-256 不变、fork 对同一模块 import 成功，并且 seatbelt import 失败仅为
`ERR_MODULE_NOT_FOUND` 或 EPERM/EACCES。其它错误一律失败。

## R4-07 启动拒绝反例

`failureTests` 使用现有 `createSubprocessNodeReplExecutor(launch)` 启动一个会写 canary 的真实
cell，分别验证：

- 损坏的 SBPL profile：`sandbox-exec` 在 cell 执行前语法拒绝。
- 缺失的 sandbox 可执行路径：spawn 返回 ENOENT，不执行 cell。

两项都必须：launcher 拒绝、cell 未产生结果、canary 前后 SHA-256 相同。这样证明失败路径没有
回退到无隔离执行；它们是预期拒绝的成功证据，不计作 D06 blocked。

## Round 5 增量证据

- 原生 C N-API：使用本机 Node 的 `include/node/node_api.h` 和显式 `/usr/bin/clang` 临时编译。
  同一个 addon 在无隔离 fork control 中真实读取、截断写并 `posix_spawn`；在最终 seatbelt
  profile 中加载后由实际 POSIX 调用返回 EPERM/EACCES。addon 前后 SHA-256 必须等于构建记录。
  缺 header、clang 失败或 addon 未加载均不能判为隔离通过。
- 固定 hash FFI：Koffi 2.15.6 从真实路径按 manifest 精确 staged，不使用包 subpath。控制写使用
  Darwin `O_WRONLY | O_CREAT | O_TRUNC`（1537），要求 libc 返回字节数、磁盘内容与
  `D06_FFI_WRITE` 完全一致；Koffi 文件前后 hash 必须等于 staged manifest 记录。
- Browser 资源：只通过 `browser-use-plugin/scripts/build.mjs` 的公开导出构建 client，并复制真实
  API manifest、documents、overview 和 README。built cell 经现有 synthetic broker 验证
  schema、token 与 list 计数；client/docs/README 写拒绝且 hash 不变。这不是真实浏览器 E2E，
  production `ZCODE_PLUGIN_ROOT` 被 cell 剥离的缺口仍未关闭。
- 完整性：固定清单拒绝 missing、hash/size mismatch、symlink、symlinked ancestor 和 path escape；
  schema 拒绝空清单、非法 id/path/hash 与重复项。篡改负例会经过实际 `verifyThenExecute` guard，
  证据必须记录 `executed: false`、`executeCalls: 0` 和 canary 不变，而不是只输出 validator 布尔值。
- Abort：fork/direct-cell 在握手可观测后由 controller 请求 abort，等待 executor 结算并确认直接
  PID 事实；不按原始 PID 发信号。该证据不证明 seatbelt 后代回收或 native Fenced stop。
- Debugger：先读取 `/usr/sbin/DevToolsSecurity -status`。当前本机为 disabled，因此固定记录
  blocked，不运行 lldb attach、不触发权限提示、不启用 Developer mode；即使未来 enabled，
  完整 isolated attach 仍需单独证据。

机器证据中的 Browser 只有 synthetic broker 兼容性；资源 SHA-256 只证明检查时刻内容，不证明
同 UID 进程无法在 check/use 之间替换，也不提供可信安装不可变性。SEA、签名包及签名身份实证、
真实 Browser、TCC/系统输入、native Fenced helper 和后代 abort 回收继续保留为 D06 blocked。
Apple notarization 不作为当前阻断项；本地 self-signed 是长期策略，待验范围仅为签名包与身份实证。

## Seatbelt allowlist

profile 完整文本、SHA-256 与逐项 allowlist 写入证据。当前只包含：

- `process-exec`：精确 Node 可执行文件。
- `file-read*`：目录 `/` 的 literal 本身（Node 24.14 启动实测需要，不是 `subpath("/")`）、
  精确 Node/bundle/canary-root、synthetic docs/client 文件，以及 `/System/Library`、`/usr/lib`
  和 `/dev/null`、`/dev/urandom`、`/dev/random`。
- `file-read-metadata`：上述精确资源与 socket 的 literal 祖先目录，仅用于 realpath/lstat；
  不包含 `subpath` 的 HOME、workspace 或整个临时目录。
- `sysctl-read`：Node 启动所需。
- `network-outbound`：只到精确 synthetic Browser broker Unix socket 一个目标。

没有 `allow default`、`process-fork`、`mach-lookup`、network-inbound 或其它 socket 授权。
cell 的 `HOME`/`TMPDIR`/`TMP`/`TEMP` 都显式指向本次临时 canary root，不是用户 HOME，也没有
增加用户 HOME 读取权限。

## 机器可读证据

stdout 是单个 JSON 对象，包含：

- Node 运行时/选中版本、真实 OS type/release/arch、bundle SHA-256、profile 完整文本/SHA-256
  /allowlist、临时资源与网络 fixture 计数。
- 每个 case 的预期、原始 observation、检查项、状态、耗时与结论。
- `failureTests` 的启动拒绝原文、canary 前后 hash 与未执行结论。
- `d06Gate: "blocked"`、`blockedScope`、`cleanup` 与最终 exit code。

R4 入口的旧 blocked scope 明确保留 native addon/FFI、debugger attach、真实 Browser、SEA 和
后代 abort 回收。R5 已在限定条件下采集同一 addon 与 staged Koffi 的 control/seatbelt 证据，
但这不构成 native addon/FFI 的完整 D06 关闭；完整门仍固定为 `blocked`。
