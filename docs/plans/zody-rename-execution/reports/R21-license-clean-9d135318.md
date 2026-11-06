# R21 许可身份修复：9d135318 干净候选验证

固定源码 commit `9d13531898e23bf86d73eef96daa9b7cbda47499`，tree `f3071970aa0182b6df3d10a85b201ed88306797f`。独立 detached 工作树为 `output/zody-rename-r21/license-clean-9d135318`；主日志、实际 argv/cwd、退出码、阶段磁盘记录和快照在 `output/zody-rename-r21/license-validation-9d135318-retry1/`。本报告不代表 R22、strict 或发行通过，也不声明独立审查结论。

首次包装器运行的 preflight 退出 0，但随后的 `git ls-files` 快照超过默认 1 MiB 缓冲而失败，**安装尚未启动**。原日志和 `recovery.md` 保留在 `output/zody-rename-r21/license-validation-9d135318/`。主控授权将缓冲设为 64 MiB 后，重新核对固定 HEAD/tree、干净 Git 状态、无 node_modules、无未跟踪 dist，才在同一尚未安装的工作树以新的 retry1 日志重新 preflight；retry1 的 frozen install 是首次实际安装，没有重试已启动的安装或生成。

retry1 使用 Node `v24.14.0`、pnpm `10.33.2`、Homebrew Python `3.14.3`，项目内 `pnpm exec node --version` 也为 `v24.14.0`。HOME/TMP/XDG 使用隔离短目录，未传真实凭据；各阶段前后记录的候选与临时目录卷最小可用空间为 `39,611,310,080` 字节，超过 8 GiB 阈值。真实 `pnpm install --frozen-lockfile` 退出 0，生命周期未禁用；50 个 workspace 成员及 92 条 lock/workspace 链接核对通过，四个 workspace 自身 bin 的目标仍是未构建 dist：CLI、server CLI、Android emulator 和 iOS simulator，明确 pending，不视为可执行入口验证。

真实 `node scripts/licenses.mjs notices` 退出 0；基础 `node scripts/licenses.mjs check` 退出 0，报告 2060 个实装包；`node --test scripts/third-party-notices.test.mjs scripts/test/third-party-npm-platform.test.mjs` 退出 0、18/18；`node scripts/licenses.mjs check --strict` 退出 1。生成前后 19 条 `reviewRequired` 内容相同，仍须完成原始材料复核，不能将 basic 通过写成 strict/发行通过。

生成前后配对文件 SHA-256：

| 文件 | before | after |
| --- | --- | --- |
| `THIRD-PARTY-NOTICES.md` | `4843ca45ba256b8de9170e47949138af930d7e9b6829acef073387d2f67508d3` | `4517e271b660037e2cbb8ccb3b390623f368424f03fb3fec79e1e5a2550c9479` |
| `third-party/inventory.json` | `47f3a41b787cbf727a8dd02310345243db9d1bf3d2aa47c5b4600cb37c61e494` | `eda34543c2eeb2118798c857e42477b52f9ff42298450a4250913dde7faa9cee` |

以 name/version 对齐，生产 npm 条目由 1217 增为 1218，仅增加 `debug@4.4.3`，其他原有包条目无更改，notices 摘要随真实原文加入更新；自动逐数组下标差异包含排序位移，不应误判为数千项包更改。实际生产图包含该版本，实装 `LICENSE` 的 SHA-256 为 `3a61c6c96caf5c1d9b623fb9b04c822b783dfcb78aa7e49c76a3f643e6ed7f95`，与 inventory 一致；已安装 `debug@2.6.9` 也被扫描到，其 LICENSE hash 为 `98c970de440dcfc77471610aec2377c9d9b0db2b3be6d1add524a586e1d7f422`，不因此将其当成生产声明。`debug-identity.stdout.log` 保留物理目录和原文 hash。主控独立 `output/zody-rename-r21/license-identity-controller/pair-audit-9d135318.json` 对全部 3081 个 inputs 和 2826 个 copied 文件实际核验，errors 为空；输入按生成器的 UTF-8 replacement/CRLF 规范语义核对，copied 文件按原始字节核对。成对差异仍需按主控流程审查，未由本任务复制回主工作树。

安装前、安装后、检查后的 source/lock/input 和物理图分别保存在 `snapshot-before-install.json`、`snapshot-after-install.json`、`snapshot-after-checks.json`；tracked 文件比较仅 pair 两文件变化，输入快照无差异。根锁三时点 SHA-256 均为 `12e11b834269bada1625ea6b086eabab1234881e2038adb2a3cac21eb345a63f`；安装前物理记录 0、安装后和检查后各 3053，后两份物理记录相同。快照保存 package manifest、symlink target/realpath 和 `.modules.yaml`，不据数量推断历史 `-146` 的具体删除内容。

本次为 macOS 当前机器的安装与许可验证，未验证 Windows 安装/构建、R22 全构建、原生最终 CUA 签名或各平台发行；四个 pending bin 和 strict 材料缺口均不能用本次结果抹平。未修改主工作树源码或锁、未提交、未发布。
