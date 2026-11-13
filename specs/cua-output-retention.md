# CUA 测试输出保留策略（output/ 构建树清理）

## 背景

CUA 验收轮次（computer-use-macos-phase1 系列）每轮在 `output/cua-*` 下解包/构建多个完整桌面候选变体：每个 `controller-*` 目录包含一个约 1GB 的解包 `.app` bundle，单轮产生 3~8GB，多轮累积已达 23GB。轮次脚本（`controller-run.py` 等）是每轮临时生成的，没有常驻测试入口，因此清理必须由仓库级工具承担，并在轮次开工时显式触发。

## 规则

### 2026-11-13 集中验收补充

- 同一份生产源码/资源的测试调整必须复用同一个已签名候选与路径，fresh HOME、夹具和证据目录不要求复制 App。测试 helper、fixture、收据断言变化不触发应用重建。
- 多项生产改动先在源码/组件验证中收敛，再装配一次候选；确需不同 Host composition 时按其独立支持合同装配，不能通过删除候选保护守卫冒充同一种运行形态。
- `cua-ax-r1-acceptance` 历史上把多个候选留在同一个受保护轮次，默认轮次清理未删除其中的重复 App。2026-11-13 按用户要求清理该轮次的 29 个过期 `controller-app*` / `controller-build*` / `controller-prepared*` 下 `.app` 构建包；保留 `controller-app-v17`、`controller-prepared-v11`、夹具及全部独立证据文件。清理回执：`output/cua-ax-r1-acceptance/duplicate-app-cleanup-receipt-20261113.json`。这是本轮明确枚举的清理范围，不把任意受保护目录都视为可删。

- 2026-11-13 最终普通 Host 固定槽同时通过六项、手机模拟触摸与截图三项后，v17 特殊候选已被取代；仅删除其旧 `.app`，保留目录内清单和全部历史证据。最终只保留 `normal-host-slot` 运行槽、`controller-prepared-v11` 签名 Helper 构建输入及夹具，不再按测试轮次复制 App。

### 2026-11-13 用户确认的额外缓存清理

用户确认清理已盘点的约 3.5 GiB 旧编译产物和缓存。本次仅按以下精确路径执行，不扩大 `clean:output` 的通用白名单：

- `cua-driver-round9/native-work/target`
- `cua-driver-round9/controller-final-native/target`
- `cua-driver-round9/controller-native-checks/target`
- `cua-driver-round9/controller-final-native/cache`
- `cua-driver-round9/controller-native-checks/cache`
- `cua-driver-round9/controller-sdk-probe/module-cache`
- `cua-driver-round9/native-work/sdk27-final/module-cache`
- `cua-driver-round9/native-work/sdk27-probe2/module-cache`
- `zody-rename-main-merge/home/Library/Caches/pnpm`
- `zody-rename-main-merge/home/Library/pnpm/package-manager-store`
- `zody-rename-main-merge/xdg/cache/pnpm`
- `zody-rename-main-merge/xdg/data/pnpm/package-manager-store`

以上均相对于 `output/`。删除前确认不存在路径越界、符号链接祖先或仍使用这些路径的进程；保留删除范围之外的报告、日志、截图、源码快照和 pins，并核对清理前后摘要。当前运行槽、签名 Helper 准备件、冻结输入及归档不在范围内。仍被构建脚本直接引用的 `native-work/cargo-home` 和 `cua-helper-round11/visual-worker/cargo-home` 也不删除。旧轮次如需再次执行，应重新编译或下载缓存。计划及删除后存在性回执保存在 `output/cleanup-receipts/`。

### 通用清理规则

- **范围**：仅作用于仓库根的 `output/`（已 gitignore）。`output/` 的每个直接子目录是一个「轮次目录」；`output/cleanup-receipts/` 例外，仅存放清理回执；`output/cua-narrow-frozen/` 例外，是冻结归档还原出的持久构建输入（见 [computer-use-macos-phase1.md](computer-use-macos-phase1.md) 2026-11-09 分发轮次），任何清理计划都不得触碰、不占保护槽位。
- **证据永久保留**：清理只删除「构建树」目录，不删除任何文件。json/log/png/md/tar.gz 等证据文件与空目录结构原样保留。
- **构建树白名单**（仅这两类，可按需在 spec 中扩展后实现）：
  - 目录名以 `.app` 结尾的解包 bundle；
  - 目录名为 `node_modules` 的临时安装。
  - `target`、`cargo-home`、`home`/`xdg` 等暂不在白名单内（归属性质不同，不随本策略删除）。
- **保留策略**：按轮次目录 mtime 降序，最新 `keep` 个「实际含非空构建树的轮次」（默认 `1`）整体保护、不清理；更早轮次仅删除白名单构建树。保护槽位只由含非空构建树的轮次占用——报告目录、空轮次不占槽，避免当日生成的回执目录把保护位从活跃 CUA 轮次手上抢走。空构建树（0 字节）不删除也不计为目标。`--keep N` 可调，`--all` 清除全部轮次的构建树。
- **默认 dry-run**：`pnpm clean:output` 只打印计划；`--apply` 才真正删除。
- **回执**：`--apply` 后向 `output/cleanup-receipts/cleanup-<时间戳>.json` 写入回执，记录 main HEAD、保护轮次、每个被删路径及字节数、删除后存在性校验（`existsAfter: false`）与总回收字节数。回执目录不参与后续轮次判定。
- **触发约定**：在 `output/` 落盘构建产物的测试轮次（CUA 验收等）开工时运行 `pnpm clean:output -- --apply`（见 `AGENTS.md` 命令表）。

## 安全边界

- 删除目标必须解析后严格位于 `output/` 之内，且目录名命中白名单；二者在计划与执行前各校验一次。
- 遍历不跟随符号链接：名为 `*.app` 的符号链接目录跳过，不删除、不进入。
- 重复运行幂等：无可删目标时 no-op 退出 0。

## 验收场景

1. 两个轮次目录（旧/新）：默认计划只删旧轮次的 `.app` 与 `node_modules`，新轮次整体不动，两边证据文件保留。
2. `--all` 时最新轮次的构建树也进入计划；`--keep 2` 且仅两个轮次时无删除目标。
3. dry-run 不删除任何内容；`--apply` 删除后目标不存在、回执写入且 `existsAfter` 全为 `false`。
4. 名为 `*.app` 的符号链接目录被跳过，其指向的目录不受影响。
5. `output/cleanup-receipts/` 不被识别为轮次目录。
6. 白名单外的目录（如 `target`、`home`）不出现在删除计划中。
