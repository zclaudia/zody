# R20.4 剩余 98 项 basename：主控验证

基线 `d49aecefa7d1c3571bfae69fe4817950654b9298`。本批移动 98 个源码/测试文件，更新 244 个额外消费者；共 342 个当前文件。加此前 100 个移动，原登记的 198 个 basename 候选均已应用。本报告不表示全仓残留、R20.4 或 P2 已完成。

主控独立核对 342 个文件，均与固定 d49 加审定补丁的隔离预期逐字节一致，98 个旧路径均不存在；补丁 SHA 为 `b25066c2fe4662ecf301bb18604a7e47a303f44837b535872488f6148fd80786`。预检已确认 manual151 交集为零；4 个不在 source/consumer 数组中的纯移动文件均有精确 basename old/new 授权。证据为 `output/zody-rename-validation/controller-{remaining-basename-preflight,basenames-final-content-audit}.json`。

预提交格式检查发现新增 resolver 回归段落需要格式化。Terra 随后仅运行该文件的 oxfmt，调整布局并移除两处调用参数尾随逗号；主控再核对 341 文件与原补丁逐字节相同、这一个文件的 TypeScript 解析后标准打印相同，最终 SHA 为 `95eef3539f0b20ffc46a4f8242c6b6d001c59b71b087ae955e783f54a9f8fd27`。格式前的完整字节审计另存 `controller-basenames-final-content-audit-pre-format.json`；格式补丁与 check 退出 0 的证据在 `final-d49/resolver-format*`。测试执行在格式调整前，未将其描述为之后重新全跑。

主控使用绝对路径的 Node 24.14.0 工具链实际复跑：

| 检查 | 真实结果 |
| --- | --- |
| 根目标 Vitest，119 文件 | 118 文件通过、1 失败；1815 测试通过、1 失败、1 跳过，退出 1 |
| CLI Vitest，4 文件 | 126 测试通过，退出 0 |
| CLI Node test | 2 测试通过，退出 0 |
| dev-docs 独立配置 | 图路径修复后 4 测试通过，退出 0 |
| `pnpm typecheck` | 退出 0 |
| `pnpm lint` | 退出 0；303 warnings、0 errors |
| `pnpm architecture:check --changed` | 当前完整未提交差异上退出 0，0 violations；不是已提交空 diff 的结果 |
| Desktop Main 独立 tsc | 退出 1，85 条诊断；完整诊断文本与旧基线按精确路径及联合字面量顺序归一后相同 |

实际 argv/cwd/退出码与日志保留于 `output/zody-rename-validation/controller-basenames-final-*`。不汇总重复执行的测试为独立用例数量。

根测试失败为 `m2-completion-boundary.test.ts` 的 `providerRevision` 全文扫描，命中 4 处 `providerRevisionSha256`。Terra 在完整未打补丁的 d49 快照实际运行原测试，得到同一失败（该文件另 38 测试通过）；扫描树来自快照、未借用当前 dist，只使用当前安装的 Vitest runner。生产扫描根、函数及四处命中均相同；首次相对 runner 查找失败也保留在证据中。见 `output/zody-rename-r20-basenames/remaining-plan/final-d49/provider-baseline-proof.{json,log}`。此项是已有失败，未被删除、放宽或记为通过。

dev-docs 的初次失败确由图 seed 仍指向旧 basename 引起。R10 停写后，主控独占串行交 R21 更新图：198 个 old/new 映射仅命中 23 处、13 个路径，节点和边不变。主控验证图相对 d49 除这些精确替换外其他字节相同，并实际复跑 4 项测试。详见 `R21-basename-graph-checkpoint.md` 与 `controller-basenames-final-graph-audit.json`；既有失效 seed 和后续符号变动仍需最终 R21 处理。

Terra 保全五个生成树和 buildinfo（9645 文件）后，从空输出实际重建 shared/services/server/ui/bootstrap 及 CLI 依赖与最终 bundle；CLI/server 的新 bundle `--version` 成功。主控再次检查 59 个迁移源码模块的 235 对实际生成文件：新输出存在、旧输出不存在，见 `controller-basenames-final-output-audit.json`。Desktop `out/main` 未清理；Main 85 条基线错误及缺失活动 CUA manifest 仍阻止本轮证明干净 Desktop 构建，交 R22/R60。源码文件存在、版本打印、WDIO discovery 均不替代原生 E2E 或最终出包。

之前暂缓的 workspace-ignore E2E basename 已迁移。实际 WDIO discovery 返回新 spec 的 file URL，后续仅离线规范化；strict/capture 解析回归已实际运行。仓内没有该 case 的旧专属 fixture，测试保留旧 fixture 名作为拒绝错误回退的合成输入，未改历史 payload 或注册新的旧名别名。原生 E2E 未执行。

环境事件：加载实际 WDIO 配置意外调用 Electron 安装脚本。该调用已终止，未再次加载配置；342 个候选文件及 649 个包清单/锁与预期一致。没有 node_modules 完整前后 hash，不能证明安装脚本的完整修改范围，也未删除或回滚未知依赖文件。原始调用、时间和结果保留于 `final-d49/electron-install-incident.json`。本批环境不能因此被宣称为经过独立干净安装的最终发行环境。

源码与图路径写者已停写，完整候选将交 DeepSeek 固定提交审查。后续仍需剩余内部类型/绑定、人工路径修复、R21 安装/生成物收口及完整阶段门禁。
