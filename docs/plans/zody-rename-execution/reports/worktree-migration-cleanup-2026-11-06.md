# 改名 worktree 迁移与最终清理（2026-11-06）

按用户后续明确要求“不需要归档数据”，本轮删除迁移阶段保留的完整 worktree 归档、旧依赖回退副本、所有权 PAX 包和两个大型逐文件清单。迁移时的完整性核验结论是历史记录，归档数据不再保留。当前轻量清理凭据位于 `output/zody-disk-cleanup-2026-11-06/`；迁移阶段命令日志与摘要仍位于 `output/zody-rename-worktree-cleanup-2026-11-06/`。

## Git 与依赖结果

- main 保持 `f3b2a820760b820a7c64a2cff294e79e0df7671f`；合并父版本为 `d5b2cc28e04a437a6e3b5fb44023cc08869cf691`、`fcd56d017b1729db0831b6b9075f1628536f7468`。
- 改名分支及两个嵌套 HEAD 均已确认合入 main，普通改动为空后，用正常 `git worktree remove` 依次移除 `output/zody-rename-r02/legacy-runtime-source`、`output/zody-rename-r47-desktop-restart/validation-worktree`、`.worktrees/zody-full-rename`，再用 `git branch -d codex/zody-full-rename` 删除本地分支。
- worktree 注册表仅剩主工作区；未动远端分支，未提交、推送、发布、部署、重新签名或改变产品行为、测试断言、锁文件、架构 baseline。F4/F5 未修复。
- `main-pre-dedup` 经 reflog 核实为 2026-11-05 11:14:26 创建的 main 去重 rebase 前备份。旧 HEAD `4cd8a8dc` 与 rebase 后、已在 main 中的 `62438624` 文件树完全相同（`37c023ea85fae93e73e2fc68a6f44902f4765146`）；33 个旧提交 ID 不在当前历史，不代表独有源码修改。用户后续要求清理后，再次确认分支没有新增提交、与 main 祖先文件树一致，已用 `git branch -D main-pre-dedup` 删除旧历史备份指针；回执见 `output/zody-disk-cleanup-2026-11-06/main-pre-dedup-deletion.json`。
- 根目录已真实执行固定 Node `24.14.0` / pnpm `10.33.2` 的 frozen/offline 安装，缓存复用 2060 包、下载 0，桌面 postinstall 实际完成；未复制旧安装图冒充安装，未在子包独立安装。Node 位于旧目录之外的 `/Users/zhvala/.local/share/fnm/node-versions/v24.14.0/installation/bin/node`。
- 主工作区有效旧目录引用由 157 降至 0，关键依赖入口可达；10 个历史 E2E 锁标记/旧生成物断链与迁移前一致，无新增断链。历史报告中的 32 处路径记录保留。

## 已执行验证

| 检查                                     | 实际结果                                          |
| ---------------------------------------- | ------------------------------------------------- |
| workspace freshness                      | exit 0；main ahead 184 / behind 0，未 fetch/push  |
| 根 `pnpm typecheck`                      | exit 0                                            |
| 根 `pnpm lint`                           | exit 0；312 warnings / 0 errors                   |
| `pnpm architecture:check --changed`      | exit 0；0/0/0                                     |
| root-workspace-owner 测试                | 4/4 pass                                          |
| third-party-npm-platform 测试            | 10/10 pass                                        |
| Electron / esbuild / 原生 PTY 子进程冒烟 | worktree 删除前、后均 exit 0                      |
| `licenses.mjs check` 与 `--strict`       | exit 1：`Third-party input changed: package.json` |
| 全量 architecture                        | exit 1：gen-ui 缺 `contract.test.ts`              |

许可检查已越过旧安装图问题；当前失败来自已提交的 main：`package.json` SHA-256 为 `2408256c6315e33307bf947ce9c5ce494cff1653dd451d736648ad163e29643a`，inventory 期待 `416cc6de9667a0ef9593de42b91af6940d30ae0011fdb42d5f1e01b4876d6ef4`。未重生成账本使检查通过，strict 未进入材料完整性阶段，既有材料限制不关闭。

原生 rebuild 总退出 0，但可选 `cpu-features` 和 SSH 加速绑定编译失败；日志保留。原依赖中的 `cpu-features` 同样不可加载，普通 SSH、Electron 和 PTY 冒烟通过。未重跑全量单测、额外桌面完整类型、跨平台发行构建或真实设备/CUA E2E，既有限制继续保留。

## 归档删除与空间核验

迁移阶段曾对 1,044,592 个条目、34,460,791,428 文件字节完成 SHA-256 比对；最终元数据复核 0 差异，并重算 49 份关键证据。用户随后取消归档保留需求，故本轮删除这些数据；不再承诺可从该归档恢复。

删除范围、逐项操作回执、实际释放空间和删除后的依赖冒烟见 `output/zody-disk-cleanup-2026-11-06/deletion-plan.json`、`deletion-receipt.json`、`disk-result.json` 与 `verification.json`。空间增量按文件系统可用字节实测，不能将 APFS 克隆的逻辑体积直接计作释放量。其他 CUA 证据及主工作区当前依赖未包含在本次归档删除清单内。

实测归档删除释放 **29.03 GiB**，删除后可用 **37.22 GiB**（按操作前后 statvfs 记录；系统并发活动会影响实时数值）。
