# TUI 启动页生命周期

更新日期：2026-10-24

本文记录 TUI 从启动页切换到主应用的生命周期合同，来源为上游 v3.16.2
`3c5b227649371507ddc4eb46ac5133afe6db1cab` 的 `apps/zcode-cli/packages/tui/src/tui.tsx`
及 `apps/zcode-cli/packages/cli/tests/tui-startup.test.ts` 对应补丁，并按本仓现状适配。
渲染内容、主题和业务状态规则仍由各自领域文档负责，本文只定义生命周期 owner 与退出路径。

## 1. 所有者

| 资源 | 唯一所有者 | 说明 |
| --- | --- | --- |
| `CliRenderer` / 终端恢复 | `runTui`（`tui/src/tui.tsx`） | 创建 renderer；`runTuiWithRenderer` 负责其后的 DESTROY 清理 |
| React root | `runTuiWithRenderer` | 每个 renderer 只创建一次 |
| 启动页 UI 与取消键 | `TuiStartupScreen`（`tui/src/app-startup.tsx`） | 只画首帧、处理启动期 Ctrl+C，不读写 session/task 状态 |
| 主应用热键与业务状态 | `TuiApp`（`tui/src/app.tsx`） | 挂载后由自身 hook 接管键盘、主题订阅和状态 |
| 启动数据加载 | CLI `loadStartupOptions` | 只提供选项，不持有 renderer，也不决定何时挂载 |

## 2. 生命周期规则

### 2.1 单一 React 根与换页

- 每个 renderer 只调用一次 `createRoot(renderer)`，也只调用一次 `root.render(...)`。
- 启动页 → 主应用必须发生在同一棵 React 树内：`runTuiWithRenderer` 渲染唯一的
  `TuiLifecycleScreen`，它用 `useSyncExternalStore` 订阅屏幕 store；启动数据就绪后
  `setScreen({ kind: "app" })`，由 React 在同一 container 内卸载 `TuiStartupScreen`
  并挂载 `TuiApp`。
- Ctrl+C 由本生命周期独占：`runTui` 创建 renderer 时传 `exitOnCtrlC: false`；
  直接调用 `runTuiWithRenderer` 的测试/嵌入方也必须用同样的配置创建 renderer
  （上游 `cli/tests/tui-startup.test.ts` 的 fixture 即如此）。否则 renderer 内置监听
  会在首次 Ctrl+C 直接 `destroy()`，绕过启动页 130 与 `TuiApp` 二次确认语义。
  实现不读写 renderer 的 private 字段。
- 不得对同一个 root 顺序调用两次 `root.render(startup)` / `root.render(app)`。
  `@mbears/opentui-react` 的 `createRoot().render()` 每次都会
  `reconciler.createContainer(...)`（`node_modules/@mbears/opentui-react/chunk-28zb33zd.js:550-554`），
  创建新的 reconciler 容器；旧的启动页容器不会被卸载。
- `useKeyboard` 只在 React `useEffect` 清理阶段调用 `keyHandler.off("keypress")`
  （`node_modules/@mbears/opentui-react/index.js:67-85`）。启动页未卸载时，其 Ctrl+C
  监听会残留到主应用阶段。

### 2.2 启动取消

- 启动页 Ctrl+C 调用 `onExit(130)`，随后 renderer DESTROY，进程以 130 退出。
- 取消后迟到的 `loadStartupOptions` 完成不得挂载 `TuiApp`，也不得触发应用查询
  （例如 `listMcpServers`）；`renderApp` 必须先检查 `destroyed`。

### 2.3 启动失败

- `loadStartupOptions` reject 时记录原始错误，关闭 renderer，等 `closed` resolve 后
  重新抛出原始错误（不包装、不吞错），由 CLI 决定进程退出码。
- 失败路径同样要恢复终端（renderer DESTROY），不能停在 alternate screen。

### 2.4 退出清理与终端恢复

renderer DESTROY 时必须：

1. `off(CliRenderEvents.FRAME, initialize)`；
2. `off(CliRenderEvents.THEME_MODE, handleThemeMode)`；
3. 清空 `themeModeListeners`；
4. `root.unmount()`，由 React 卸载当前屏幕并释放其 `useKeyboard` 订阅；
5. resolve 退出码，`runTuiWithRenderer` 返回后终端已恢复。

DESTROY 后到达的 FRAME、主题检测结果或 `loadStartupOptions` 结果都不得再渲染。

### 2.5 主题检测时序

- 首屏不得等待终端主题回复；`resolveInitialTerminalThemeMode` 与首帧并发。
- 启动页存在时，主题变化直接更新背景色；主应用挂载后经注入的
  `subscribeThemeMode` 分发给 `TuiApp`，不另建订阅 owner。

## 3. 反证与实现记录（2026-10-24，I09）

### 3.1 red 阶段（本地基线）

I09 原判「疑似已覆盖」不成立。修复前在原始工作区执行：

```bash
pnpm --dir apps/zcode-cli/packages/tui test
```

输出（节选）：

```text
not ok 15 - startup screen releases Ctrl+C before the ready app takes over
  error: 'Expected values to be strictly equal: true !== false'
  at tests/tui-app.test.ts:604
# tests 234
# pass 232
# fail 2
```

同一次运行的另一条 `not ok 5 - starts without a runtime readiness system message`
是本机 Node 22 下的既有 flake（HEAD 基线同样失败，与本项无关，见 §5）。

独立复现（临时脚本，已删除）：启动页可见 → 启动数据 resolve → 单次 Ctrl+C 后
`outcome = 130`，即启动页监听仍存活并直接销毁 renderer。根因：

- 旧实现先 `root.render(TuiStartupScreen)`，启动数据完成后对同一个 root 再
  `root.render(TuiApp)`。`@mbears/opentui-react@0.2.15` 的 `createRoot().render()`
  每次都会新建 reconciler container（`chunk-28zb33zd.js:550-554`），旧启动页容器
  不会被卸载。
- `useKeyboard` 只在 React `useEffect` 清理阶段调用 `keyHandler.off("keypress")`
  （`index.js:67-85`）；启动页未卸载时其 Ctrl+C 监听会残留到主应用阶段。

### 3.2 现实现

- `runTuiWithRenderer` 只 `root.render` 一次 `TuiLifecycleScreen`；屏幕 store 经
  `useSyncExternalStore` 驱动换页，启动页由 React 卸载，键盘订阅随之释放。
- 主题/启动数据逻辑保持原 owner；DESTROY 清理、启动失败/取消、终端恢复未改。
- 测试 fixture 显式 `exitOnCtrlC: false`，与 `runTui` 的 renderer 配置一致；
  实现不读写 renderer 的 private 字段。

### 3.3 上游 v3.16.2 逐 hunk 比对（2026-10-24）

取数命令（本会话实际执行，输出已核对）：

```bash
GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/zai-org/ZCode.git
# 3c5b227649371507ddc4eb46ac5133afe6db1cab  HEAD
# 3c5b227649371507ddc4eb46ac5133afe6db1cab  refs/heads/main
curl -sSfL "https://raw.githubusercontent.com/zai-org/ZCode/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/<path>" -o <path>
```

对 7 个相关文件逐一 diff 的结论：

| 文件 | 上游 vs 本地 | 处理 |
| --- | --- | --- |
| `tui/src/app-startup.tsx` | 完全一致 | 无需移植 |
| `tui/src/app-keyboard.ts` | 完全一致 | 无需移植 |
| `tui/src/app-keyboard-helpers.ts` | 完全一致 | 无需移植 |
| `tui/src/tui.tsx` | 上游同为本仓现状的「单 root + `useSyncExternalStore` 换页」 | 本地按同一合同实现（store/组件拆名不同，行为一致） |
| `cli/tests/tui-startup.test.ts` | 上游 fixture 含 `exitOnCtrlC: false`，本地基线缺失；品牌文案为 Zody | 恢复该配置；保留品牌差异 |
| `tui/tests/tui-app.test.ts` | 上游无 I09 生命周期反例；本地新增。既有 mode 用例差异属既有 fork 漂移 | 保留本地反例 |
| `tui/tests/ctrl-c-exit-guard.test.ts` | 上游仅 3 个用例；本地新增「fresh confirmation」 | 保留本地反例 |

复审环境曾报告 `git ls-remote` 无输出、无法核对；本记录的取数与 diff 均在本次实施
环境实际执行，可按上述命令复核。

## 4. 验收场景（UP316-I09）

| 场景 | Setup → 动作 | 必须断言 | 测试 |
| --- | --- | --- | --- |
| 启动页成功切主应用 | 启动页可见 → `loadStartupOptions` resolve → 应用可交互 | 启动页文案消失；单次 Ctrl+C 不退出，二次 Ctrl+C 才 exit 0；启动页键盘订阅已释放 | `tui/tests/tui-app.test.ts`、`cli/tests/tui-startup.test.ts` |
| 启动页取消 | 启动页可见 → Ctrl+C → 迟到的 startup options resolve | exit 130；应用查询为 0；FRAME/THEME_MODE 监听为 0；renderer 已销毁 | `tui/tests/tui-app.test.ts`、`cli/tests/tui-startup.test.ts` |
| 启动失败 | 启动页可见 → `loadStartupOptions` reject | 抛出原始错误；renderer 已销毁；FRAME/THEME_MODE 监听为 0 | `tui/tests/tui-app.test.ts`、`cli/tests/tui-startup.test.ts` |
| 应用退出 | 应用运行中 → renderer DESTROY | 返回当前退出码；renderer 已销毁；FRAME/THEME_MODE 监听为 0；keypress 监听回落到挂载前基线（证明 `root.unmount()` 执行了 `useKeyboard` 清理） | `tui/tests/tui-app.test.ts` |
| 退出键只处理一次 | 确认退出后继续按 Ctrl+C | 需要新的二次确认，不能复用上一次确认 | `tui/tests/ctrl-c-exit-guard.test.ts` |

剪枝：I09 不枚举 Web UI；不覆盖真正终端 smoke 之外的平台差异。node:test 使用
`@mbears/opentui-core/testing` 的测试 renderer，属于包内生命周期验证，不等价于真实
终端验收。终端恢复只由 `renderer.destroy()` 的合同保证；包内测试可断言的是
`isDestroyed` 与监听释放，真实终端状态留给 §5 的未完成项。

## 5. 验证入口与剩余缺口

本会话实际执行（2026-10-24）：

- `pnpm --dir apps/zcode-cli/packages/tui test`（环境默认 Node v22.23.2）：
  I09 反例均通过；全量多次运行出现 234/234，也出现过 233/234，唯一失败恒为既有
  `starts without a runtime readiness system message`（HEAD 基线同样失败，与本项无关）。
- 同一命令在仓库钉住的 Node 24.14.0（`mise.toml`；`package.json` engines >=24）下
  连续 3 次 234/234 通过。
- `cd apps/zcode-cli/packages/cli && node --disable-warning=DEP0205 --import tsx --test tests/tui-startup.test.ts`：
  7/7 通过。

未完成/未冒充：

- 真实终端 smoke（启动页 → 应用 → 退出后 `stty`/光标恢复正常）未执行，需要人工终端；
  这是 UP316-I09 的剩余验收缺口。
- 环境默认 Node 22 与仓库要求 Node >=24 不一致；上面记录的既有 flake 只在该越界
  环境出现，不能据此声明真实终端或 CI 结果。
