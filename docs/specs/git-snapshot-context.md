# git 快照与环境仓库判定（adapters git-snapshot）

状态：已实施。来源：上游 v3.17.1（`a60ba6a7`）`apps/zcode-cli/packages/adapters/src/context/git-snapshot.ts`、`exec/windows-executable.ts`（台账 F05）；本仓适配差异见文末。

## 目标与范围

`packages` 侧 core context（`env-info`、gitStatus 附加段）需要的 git 事实全部由 adapters 的 `context/git-snapshot.ts` 单点产出：是否在仓库、分支、主分支、用户、status、近期提交。本仓消费方只有 `NodeContextSourceAdapter.detectEnvInfo`（`context/index.ts`），快照以 `Partial<EnvInfo>` 合并进环境事实；不引入上游的 `GitContext` 契约与 `resolveEnvironment` / `resolveGitContext` 端口。

## 行为契约

- **是否在仓库是文件系统事实，不启动 git。** 从目录的真实路径（realpath）向上走到根，第一个含 `.git` 的目录即仓库根；`.git` 是目录（普通仓库）或文件（worktree / submodule 的 gitdir 指针）都算。真实路径读不到（目录已删除等）时按打开时的路径查找，不抛错。无 git、git 卡死、命令取消都不影响该判定。
- **仓库判定结论 owner 是 git-snapshot，Environment 与 gitStatus 同源。** `isGitRepository` 与 `gitStatus: "not_repo"` 来自同一次判定，不会互相矛盾；git 命令全部失败时仍出 in-repo 结论（字段退回默认值），不再折叠成"不是仓库"。
- **非仓库结论记忆（本仓适配）。** 缓存 key 是目录 realpath 身份：只有"确定非仓库"（realpath 已解析、向上至根无 `.git`）才进进程内记忆，同身份二次调用不再向上查找；"没读到"（realpath 失败，按打开路径得出的负结论）不进记忆，下次调用重查，目录重建后结论可更新。正结论不记忆。
- **快照命令集与并行执行。** 分支 `symbolic-ref --short -q HEAD`（detached / 无符号引用回退 `HEAD`）、主分支 `symbolic-ref refs/remotes/origin/HEAD` + `show-ref --verify`、用户 `config user.name`、status `--no-optional-locks status --short --ignore-submodules=dirty`（2k 字符截断）、`log --oneline -n 5`。五条命令互不依赖，`Promise.all` 并行；调用方可传 `AbortSignal` 贯穿每条命令；单命令超时 3s。失败命令丢弃 stdout/stderr，不写入 provider-visible 上下文。
- **自动 git 安全化。** 自动 git 不是工具调用、不经权限判定，因此：
  - git 以 PATH 上找到的绝对路径执行（Windows 每目录先试 `.com` 再 `.exe`，不看 PATHEXT；查找不加工作目录），不会运行工作区里放置的同名 git；
  - PATH 条目按平台拆分（Windows `;` 且去首尾引号）、只留绝对路径条目，一个不剩时用空设备；
  - 去掉继承的 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_CONFIG_*` 等仓库与配置选择变量（大小写不敏感），固定注入安全环境（禁 prompt、禁 lazy fetch、禁协议扩展等）；
  - 每条命令带同一组配置覆盖（禁用全部 hooks、关 fsmonitor、禁 submodule 递归等），以 `-c` 前缀与 `GIT_CONFIG_COUNT` 镜像双通道传入，仓库 `.git/config` 的 fsmonitor / hooks 注入对自动 git 无效；
  - 找到的 git 可执行文件在进程内复用；没找到不记忆，装好 git 后下一次读取即可用。

## 验收场景

1. 仓库目录（含嵌套子目录、worktree `.git` 文件、submodule）与 symlink 指入/指出的目录，判定与 git 自身在真实路径下的行为一致；判定过程零 git 调用。
2. 全部 git 命令超时 / 取消 / git 缺失：仍返回 `isGitRepository: true` 与默认字段，不误报 not_repo。
3. 五条快照命令并行发出（gate 证明），结果字节与串行一致；AbortSignal 传入后每条命令都收到。
4. 确认非仓库的目录第二次判定零 `.git` stat、零 git 调用；realpath 读不到的目录负结论不被记忆，目录补建 `.git` 后结论翻转为仓库。
5. 自动 git 命令带全量加固前缀与环境镜像；继承的 `GIT_DIR` 等不改变快照指向。

## 与上游的差异

- 上游快照返回 `GitContext` 并新增 `resolveEnvironment` / `resolveGitContext` 端口与 runtime 层 `nonGitDirectories` 记忆；本仓端口只有 `resolveContextSources`，快照返回 `Partial<EnvInfo>`，非仓库记忆收在 git-snapshot 进程内（key 为 realpath 身份），语义与上游 runtime 层记忆一致。
- 上游 `findProjectRoot` 复用 `findGitRoot` 并把结论传入快照（一次向上查找）；本仓 `context/index.ts` 不在 F05 落点内，仍按打开时路径自建查找，快照内再做 realpath 判定——一次 context 解析存在两轮向上查找，属已登记的后续收口项。
- 上游规则文档 `docs/design/v2/loop/meta-user-context.md` 在本仓不存在，规则以本文为准。
