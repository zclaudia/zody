# R20 process marker bounded independent acceptance

**结论**

可以接受这次 **R20 process-marker 独立代码交付**，作为清理后交接的 bounded candidate。未发现新的 marker 回归或实质性证据错误；但这不等于 R20/R48/发行阶段通过，失败的 control-entry 资源生命周期问题仍需保留。

**核验结果**

- `source-hashes-final.json` 的 SHA 为 `5bdd9cb319e85da03b4f8701b2c25b400fdd40eb8bf1f304f7ed04de3f945ff6`，33/33 当前路径内容与记录一致；相对 precheck 仅新增 `docs/dynamic-workflow/launch.md` 和阶段 report，原 31 个 product/test/source hash 全部未变。
- `final-evidence-index.json` 的 SHA 为 `042b4bbd404960131194e1215e9d98c06c71402c579f0198b9c67a0702a72d62`；73 条 raw log、26 条 command record 的文件存在性、字节数和 SHA 均匹配，runner record 的 exit/log hash 也一致。
- `addendum-2-launch-doc` 实际只改了 `docs/dynamic-workflow/launch.md:2091` 所在三行：`__zody-dwf-child`、`.zody/workflow-runs`、`apps/zody-cli`。`controller/production-equivalence.json` 的 13 个 production 文件在基线内容上应用指定 mapping 并排除两条新增注释后，与当前内容逐字节一致。
- SEA attempt 2 的真实证据成立：`candidate/apps/zody-cli/packages/cli/dist/zcode-darwin-arm64` 为 232,518,016 bytes，SHA `e656ae7f1d05f00a050f841d20dae16f2eedf991d827a6d076da9bef7630b8ac`，inode `166219935`；probe 记录父 PID 3239、子 PID 3304，子进程 argv 明确包含 `__zody-dwf-child`，双方 executable、inode、SHA 相同。SQLite journal 同一 run 的 script 为 `return { ok: 42 };`、status 为 `completed`、result 为 `{"ok":42}`，parent exit 0 且无 surviving observed PID。
- `probe-evidence/SHA256SUMS` 的 result/stdout/stderr 三项目前均匹配；三个 build metafile 均为有效 JSON。尝试 2 的 `post-attempt-restoration.json` 显示 17/17 输出路径恢复、2151 source 和 32 worker 均无 mismatch，host hash 也匹配。首次 capture 失败记录仍在 `sea-controlled/`，失败原因 `metafile capture missing tui-bundle` 未被覆盖。
- 原始 probe 的 `binary` 路径在恢复后已不存在，但同一 inode/SHA 的 candidate 仍在 `sea-controlled-attempt2/candidate`；`post-attempt-restoration.md` 已明确说明这一关联，因此不是证据矛盾。
- 阶段 report 明确保留了 R54/R41 不变，并写清 9/10 红测、Windows UNEXECUTED、R48 和完整发行未过关。

**保留门禁**

- `apps/zody-cli/packages/node-repl-host/test/control-only-entry.test.ts:173` 的 ready high-EBADF 用例仍为 9/10，1 failed；异常在 `:101` 超时。现有证据指向前述基线控制 fd 生命周期缺陷，修复范围仍待用户决定，本次没有新增或隐藏该失败。
- Windows 实际执行 **UNEXECUTED**；完整 R20/R48/发行门禁未通过。
- 本次 33 路径没有手机/phone 工作交叉；唯一 scope 外变更是 controller-owned `docs/plans/zody-rename-execution/file-assignments.json`。未发现需要阻止独立代码交付交接的新增回归。

因此可接受为独立 marker 代码交付并进入清理/交接，不可表述为全 R20 全绿或最终发行验收。
