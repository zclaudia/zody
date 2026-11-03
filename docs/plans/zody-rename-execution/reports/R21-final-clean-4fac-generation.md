# R21 clean install 与许可生成：4fac

独立 detached worktree `output/zody-rename-r21/final-clean-4fac2fb0` 固定 HEAD `4fac2fb0f23628578347479232dfdb458d74885f`、tree `7d8d0c1f4f871b2b1167e10dc57f2b7faa7c6f29`；日志和原始/生成后 pair 位于 `output/zody-rename-r21/final-validation-4fac2fb0/`。初始源码干净，node_modules 与 dist 目录均为零；Node 24.14.0、pnpm 10.33.2。预检时磁盘可用 11,545,064 KiB，生成后 10,470,908 KiB，检查后 10,471,120 KiB，均高于 8 GiB 余量。

根工作树真实 `pnpm install --frozen-lockfile` 退出 0，含 Desktop 的 node-pty postinstall/rebuild；50 个 workspace 成员、92 条 manifest workspace 引用和 92 条 lock link 双向一致，目标实际路径和包名均正确。root workspace owner test、turbo/tsx 入口均退出 0。lock 前后及 7c 基线 SHA-256 均为 `12e11b834269bada1625ea6b086eabab1234881e2038adb2a3cac21eb345a63f`；packages、snapshots、patchedDependencies 逐字段比较无变化。workspace 依赖对应 bin 消费记录为 0；四个 workspace 自有 bin（CLI、server、iOS、Android）指向尚未构建的 dist，明确 pending，不称其已可执行。

实际 `node scripts/licenses.mjs notices` 退出 0，生成器报告 1217 个 package versions、12 copied components 和 18 native archives。生成前后 notices SHA-256 分别为 `188e3fa1943d8db9aba911e9e7d706391fa0ca1a4ae86e4ec98e247e5abf29e7` 与 `4843ca45ba256b8de9170e47949138af930d7e9b6829acef073387d2f67508d3`；inventory 分别为 `2694a09f0cd44b0edb0b69b0a94b72fc410f45a8d853152ffb11ce6cee5c8d4a` 与 `47f3a41b787cbf727a8dd02310345243db9d1bf3d2aa47c5b4600cb37c61e494`。生成后 inventory.noticesSha256 与 notices 实际字节一致；对象重复键和集合重复 identity 均为 0。候选 tree 中只有这两份生成物为 tracked 修改，根锁未变。

完整递归比较 `inventory-comparison.json` 有 143 个字段变化：copied 27、inputs 115、noticesSha256 1；inputs 中 40 changed、37 removed、38 added。独立分区核对 `independent-section-summary.json`：packages、patches、embedded、runtimes、notInstalled、reviewRequired、exceptions 均相等；12 个 copied 的 license/source/revision/归属等非 roots/files 元数据均相等。三项 copied roots 的变更对应 Fig registry、VS Code wire-codec、Superpowers license 的现行路径；其他 copied 文件路径或内容 hash 变化逐项保留在完整 diff。`notices.diff` 显示 notices 原文只变更这三处路径，许可原文与来源行其他部分不变。生成阶段状态为 **review-required**：上述差异需由主控逐项独立裁决，不因生成退出 0 自动批准。

实际只读检查按顺序分别执行：基础 `node scripts/licenses.mjs check` 退出 0（2058 个实装包），`node --test scripts/third-party-notices.test.mjs scripts/test/third-party-npm-platform.test.mjs` 退出 0、11/11；`node scripts/licenses.mjs check --strict` 退出 1，原因是 19 项 `reviewRequired` 原始材料义务未解决，具体项保留在 `license-strict.stderr.log`。因此 runner checks 阶段如实标记 failed，不能将基础 check 或生成通过写成 strict/发行通过。精确 argv、cwd、每条退出码与 stdout/stderr 哈希见 `state.json`。

未修改生成器、来源、版本、flags 或审核条目；未安装额外依赖、构建、运行 Docker、签名或发布。该 pair 尚在独立候选树等待主控裁决和成对集成，记录不代表完整 R21/R22 通过。
