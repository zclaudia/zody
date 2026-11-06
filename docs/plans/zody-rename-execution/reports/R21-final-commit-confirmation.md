# R21 最终提交确认：ad859

复核对象为 `output/zody-rename-r21/final-clean-4fac2fb0`，实际 HEAD `ad859813ec8ace8e21d418186cfe1d16939abb59`、tree `afd5f87a9dfb8f05446d5feaf1f5d37d1a9f36e2`；操作前后 Git 状态干净，HEAD/tree 不变。这个工作树的首次空依赖安装发生在 `4fac2fb0f23628578347479232dfdb458d74885f`，随后携带同一次安装的依赖提升到 ad859；**本次不是 ad859 从空 node_modules 开始的安装**。4fac→ad859 仅为生成的 notices/inventory pair 及执行台账/报告，source 和 dependency inputs 不变；实际文件清单和提升记录分别见 `output/zody-rename-r21/final-confirmation-ad859/promotion-diff.stdout.log` 与 `final-validation-4fac2fb0/final-candidate-promotion.json`。

以 Node 24.14.0 和 pnpm 10.33.2 在该工作树根目录实际重跑 `pnpm install --frozen-lockfile`，退出 0，包含 root prepare 和 Desktop node-pty postinstall/rebuild；日志显示锁未重解析并移除了 146 个已装包。复验 50 个 workspace、92 条 manifest workspace 依赖与 92 条 lock link 一致，实际目标和 package.name 无错；root workspace owner test、turbo/tsx 入口及基础 `node scripts/licenses.mjs check` 均退出 0。无 workspace 依赖 bin 消费记录；四个 workspace 自有 bin 仍指向未构建 dist，单列 pending，不宣称实际执行入口已验证。

操作前后根锁 SHA-256 保持 `12e11b834269bada1625ea6b086eabab1234881e2038adb2a3cac21eb345a63f`；notices 保持 `4843ca45ba256b8de9170e47949138af930d7e9b6829acef073387d2f67508d3`，inventory 保持 `47f3a41b787cbf727a8dd02310345243db9d1bf3d2aa47c5b4600cb37c61e494`，均与 4fac 实际生成后的 pair 一致。磁盘可用量各阶段至少 10,518,466,560 bytes，高于 8 GiB 余量。完整实际 argv、cwd、退出码、时间、分离 stdout/stderr 哈希见 `output/zody-rename-r21/final-confirmation-ad859/confirmation.json`；链接和 bin 逐项结果见同目录 `links-and-bins.json`。

同一 pair/source 输入下，4fac 生成验证已实际执行许可测试 11/11 和 strict check：strict 退出 1，原因是 19 项未解决的 `reviewRequired`；本次未重复生成、许可测试或 strict，不把基础 check 成功写成 strict/发行通过。原结果及逐字段 pair 审核证据在 `final-validation-4fac2fb0/` 和 `R21-final-clean-4fac-generation.md`；是否接受差异由主控独立裁决。未执行 build、WDIO、Docker、签名或发布，本确认不是完整 R22 或发行验收。

后续独立审查确认：上述 basic check 的名称过滤遗漏了与 workspace 同名的第三方 debug，因此 exit 0 不能证明完整生产许可覆盖。生成对本身的 diff 获 scoped PASS，R21 完整覆盖仍为 CHANGES_REQUIRED；详见 [许可覆盖缺口](R21-license-coverage-gap.md)。重装前未保存逐包物理图，日志中的 `-146` 不能由当前 skipped 数量反推具体删除清单，详见 `final-confirmation-ad859/reinstall-pruning-audit.md`。
