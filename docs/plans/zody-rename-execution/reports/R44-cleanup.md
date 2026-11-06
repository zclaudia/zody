# R44 限定验收后的清理

2026-11-04，R44 更正后的代码与普通 Host 主桥真实冒烟获得独立限定验收；默认 arm64 构建、CUA 与 Agent 对话边界仍未通过，详见 `R44-independent-acceptance.md`。

主控重新核对五个本任务独占临时根的目录身份、完整文件集合与 SHA-256，并确认无进程或打开文件引用。将日志、源码、合成状态原样搬到 `output/zody-rename-cleanup-20261104/w4-preflight/preserved-*`，核验搬存前后文件哈希及 inode，再删除清单中的 22 个 tsx/Chromium 缓存子目录。没有删除源码、日志、分支、worktree 或当前构建。

本次删除分配空间 11,235,328 字节；同卷可用空间实测增加 11,153,408 字节（10.64 MiB），清理后可用约 36.48 GiB。加上 R41/R42 的清理，本轮 W4 两次测量合计增加约 12.45 MiB。搬存本身不计作释放空间，也不构成在新位置重新运行成功。

当前 Desktop out 与 staged agent 的 6,709 项产物已重新校验，全部摘要一致；117 项源码快照与构建关联也一致。完整 out 清单包含较早生成但保留的 browser-core/E2E/buildinfo 文件，不将其全部归因于本次构建。

精确证据：`w4-preflight/{r44-manifest.json,r44-smoke-final-manifest.json,r44-execution-preconditions.json,r44-cleanup-result.json}`；保留产物核验：`output/zody-rename-w4/integration/retained-artifact-verification.json`。当前 main、实现和 R02 旧基线 worktree 均有用途，无可删闲置分支。
