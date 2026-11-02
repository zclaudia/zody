# 手机远控视口、输入与触控（mobile-viewport-input-and-touch）

范围：`packages/web/mobile.html` 入口与 `packages/ui` 共享组件在移动端（iOS Safari / Android WebView）的触控目标、键盘避让、视口高度与通知中心语义色。桌面 renderer 与桌面 Web 的密度、布局不受本文影响。

背景：手机远控 UI 走查产出 94 条已确认发现（12 high / 44 medium / 38 low）。本文固化其中五项已定决策（D1–D5），作为后续修复轮的验收依据。逐条发现的 id 与行号维护在本规格上游的走查记录中，**截至本文撰写未落库到本仓库**（本文撰写时 `grep -rn "走查" docs/` 无其他命中）；清单落库后应在本节补充其路径，落库前各条发现的引用以本文 D1–D5 决策为锚点（唯 touch-2 在 D5 显式引用，复核结果登记在本文 §5）。产品背景与链路见 [web-remote-control-architecture](web-remote-control-architecture.md)。

## 决策总表

| #   | 决策                                                                                                       | 状态     |
| --- | ---------------------------------------------------------------------------------------------------------- | -------- |
| D1  | 触控目标命中区 ≥44×44px，作用域 `(hover: none)` / `(pointer: coarse)`，桌面密度不变                        | 本轮实施 |
| D2  | 键盘避让：viewport `interactive-widget=resizes-content` + `installMobileKeyboardInsetTracker()` 唯一所有者 | 本轮实施 |
| D3  | 移动端全屏页 `100dvh` / `min-h-dvh`，禁止新增 `min-h-screen`                                               | 本轮实施 |
| D4  | 通知中心错误用 `text-destructive`、次要信息用 `text-foreground-subtle`，不新增 token                       | 本轮实施 |
| D5  | 双击缩放（走查 touch-2）复核未复现，本轮不处理，真机验证后再定                                             | 挂起     |

## 1. 触控目标（D1）

- 可点击元素（按钮、图标按钮、菜单项、列表行、开关等一切绑定 click/touch 响应的元素）在触屏态的**命中区**必须 ≥44×44px。视觉尺寸可以保持桌面尺度（图标、字号不变大），命中区通过 padding、透明扩展层或伪元素补足。
- 命中区取元素实际响应点击的有效区域（含 padding 与扩展命中区），任一方向不足 44px 即为缺陷。
- 作用域统一为 `@media (hover: none) and (pointer: coarse)`，与 `packages/ui/src/lib/mobileTextInput.ts:3` 现有移动判定使用同一 media 内核；触控目标规则不附加宽度条件。`(hover: hover)` 与无 media scope 的默认样式保持桌面现状，不改桌面密度。
- 菜单与选项行触屏态高度 ≥44px。现网基线：`packages/ui/src/components/ui/select.tsx:154` 选项行为 `min-h-7`（28px），触屏态需以命中区方式抬升至 ≥44px；桌面态维持 `min-h-7` 不变。
- 优先用现有尺寸体系（padding、行高）撑出命中区；不为触控目标新增全局尺寸 token 或组件变体体系。

## 2. 键盘避让（D2）

### 2.1 视口声明

`packages/web/mobile.html:6` 的 viewport meta 增加 `interactive-widget=resizes-content`：

```html
<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content"
/>
```

该字段是 Android Chromium 的键盘行为开关：键盘弹起时压缩 initial containing block，使 `100dvh` 布局跟随缩小。iOS Safari 不识别该字段并忽略之，iOS 侧避让由 2.2 的 tracker 承担。桌面 `packages/web/index.html` 不加此字段。

### 2.2 状态所有者

- 新建 `packages/ui/src/lib/mobileKeyboardInset.ts`，导出 `installMobileKeyboardInsetTracker()`。它是 CSS 变量 `--zcode-keyboard-inset` 的**唯一所有者与唯一写入口**；任何组件、hook 只读该变量，不得自行监听 visualViewport 计算键盘 inset 或直接写该变量。`window.visualViewport` 不存在时的降级行为见 2.4，降级态同样不产生第二写入口。
- `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx:268` 已有的 visualViewport resize 监听属于桌面侧 pane 动画稳定标记，与键盘 inset 无关，不合并、不互斥。
- 变量挂在 `document.documentElement` 上（与 `data-zcode-browser-theme-surface` 等浏览器级表面同一层级），生命周期等于页面，不随组件挂载/卸载波动。
- 安装点是手机入口 `packages/web/src/mobile-remote/main.tsx:17`，与 `installDocumentHiddenMotionPause()` 同批做首屏初始化；经 `packages/ui/src/index.ts` 公开导出（对齐 `index.ts:105` 的 `installDocumentHiddenMotionPause` 导出方式，走公开入口，不做深路径导入）。桌面 `index.html` 入口与 Electron renderer 不安装。

### 2.3 事件顺序

```text
visualViewport resize / scroll（同一帧可能触发多次）
        │
        v
rAF 合并：取消上一帧未执行的回调，每帧最多计算一次
        v
keyboardInset = max(0, window.innerHeight − (visualViewport.height + visualViewport.offsetTop))
        v
documentElement.style.setProperty('--zcode-keyboard-inset', '<n>px')
        v
消费方 padding（.zcode-keyboard-inset-bottom 等）随后续样式重算生效
```

- 数据源只有 `window.visualViewport` 的 `resize` 与 `scroll` 事件（iOS 聚焦输入、键盘弹起收起、工具栏收展都表现为这两个事件；`scroll` 覆盖 visual viewport 相对 layout viewport 平移导致的 `offsetTop` 变化）。
- 上图中的事件绑定、初值计算与变量写入全部以 `window.visualViewport` 存在为前提；不存在时整个链路不执行（降级行为见 2.4），不得对 undefined 取 `height` / `offsetTop`。
- 写入约定：值固定为 px 单位的非负数；键盘收起必须写 `0px`，运行期不删除变量（消费方 calc 依赖其稳定存在）。
- Android Chromium 在 `resizes-content` 下 layout viewport 已随键盘缩小，此时计算结果≈0，避让由 `100dvh` 跟随缩小承担；该变量主要覆盖 iOS Safari 与不支持 `resizes-content` 的 WebView。

### 2.4 安装与卸载契约

参照 `installDocumentHiddenMotionPause()` 的模式（`packages/ui/src/lib/documentHiddenMotionPause.ts:12-25`）：

- 幂等安装：同一页面已有活动实例时，重复调用 `installMobileKeyboardInsetTracker()` 不叠加监听，返回现有实例的卸载函数。
- 安装时同步计算并写入一次初值，避免首帧读到空值。
- 卸载函数：移除 `resize`/`scroll` 监听、取消待执行的 rAF 回调、删除 `--zcode-keyboard-inset` 变量，页面恢复安装前状态；重复调用安全。
- 卸载后再次安装必须恢复完整功能（监听 + 初值写入）。
- `window.visualViewport` 缺失分支（老 WebView、jsdom 等测试环境）：安装必须不抛错——不绑定任何监听、不执行计算、不写变量（消费方走 `var(--zcode-keyboard-inset, 0px)` 的 fallback），返回幂等卸载函数；该分支下的卸载与重复安装同样为不抛错的安全无操作。该分支由安装点 `packages/web/src/mobile-remote/main.tsx:17`（React 挂载前的顶层执行）直接受益：不支持 visualViewport 的入口不能因 tracker 崩溃。

### 2.5 styles.css 工具类

`packages/ui/src/styles.css` 提供三个工具类，语义如下：

| 类名                           | 定义                                                                                 | 用途                              |
| ------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------- |
| `.zcode-safe-area-top`         | `padding-top: env(safe-area-inset-top)`                                              | 顶部刘海/状态栏安全区             |
| `.zcode-safe-area-bottom`      | `padding-bottom: env(safe-area-inset-bottom)`                                        | 无键盘场景的底部安全区            |
| `.zcode-keyboard-inset-bottom` | `padding-bottom: max(var(--zcode-keyboard-inset, 0px), env(safe-area-inset-bottom))` | 需要键盘避让的固定底栏 / composer |

底部规则：同一元素只取其一。需要键盘避让的表面用 `.zcode-keyboard-inset-bottom`（内部已含安全区兜底，键盘收起时回落到安全区）；仅安全区场景用 `.zcode-safe-area-bottom`。同层叠加两个类会造成双重补偿，视为缺陷。

落地轮次：**styles.css 中三个工具类本体与 `--zcode-keyboard-inset` 变量机制属 D2 本轮实施**（与决策总表、关联文件一致）；「下轮实施」仅指业务表面（底栏、composer 等）对工具类的消费接线，下轮逐表面落地。

## 3. 视口与安全区高度（D3）

- `packages/ui/src/styles.css:137` 的 `#root { height: 100dvh }` 已是动态视口基线。移动端全屏页容器（`packages/web/src/mobile-remote` 与 `Mobile*` / `WebRemoteControlMobile*` 组件）一律使用 `h-dvh` / `min-h-dvh`（即 `100dvh`）。
- 移动入口禁止新增 `min-h-screen` / `h-screen`：`100vh` 在 iOS Safari 不随工具栏收展与键盘弹起缩小，会造成溢出或遮挡。
- 桌面与桌面 Web 的 page roots 维持 DESIGN.md 现行规则（`h-full` 或 `min-h-screen`）不变，不做 dvh 迁移。

## 4. 通知中心颜色（D4）

- 错误信息使用 `text-destructive`（`--color-destructive`，`packages/ui/src/styles.css:292`）；次要信息使用 `text-foreground-subtle`（`--color-foreground-subtle`，`packages/ui/src/styles.css:284`）。走既有语义色，**不新增颜色 token**。
- 迁移点：`packages/ui/src/MobileNotificationCenter.tsx` 中 `text-error`（:78、:92、:97）改为 `text-destructive`；`text-muted-foreground`（:102、:120、:126、:129、:135）改为 `text-foreground-subtle`。
- `role="alert"` 等语义结构保持不变；色板数值单一来源在 `styles.css`，文档不复制。

## 5. 双击缩放（D5，挂起）

走查 touch-2（双击缩放）复核未复现。本轮不引入任何 `touch-action` 或 viewport 限制，避免掩盖真因。处置：真机（iOS Safari + Android WebView）验证后把复现与否登记到本节（下方记录）；走查清单落库后同步回填。若届时复现，按当时证据另立决策，不并入本轮。

> touch-2 真机复核记录（待回填）：环境未验证 / 结果未登记。

## 6. 验收清单

| 编号 | 场景                     | 环境                                                           | 通过标准                                                                                                                                                                                                                                                                                      |
| ---- | ------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | 触屏态命中区             | DevTools 模拟 `(hover: none) and (pointer: coarse)` + 真机抽查 | 可点击元素命中区 ≥44×44px；视觉尺寸与桌面一致不放大                                                                                                                                                                                                                                           |
| A2   | 桌面密度回归             | 桌面 renderer / 桌面 Web                                       | Button 变体高度（h-5–h-8）与菜单、选项行高不变，无触屏 media 泄漏到桌面                                                                                                                                                                                                                       |
| A3   | Android WebView 键盘避让 | Android WebView 真机                                           | viewport 含 `interactive-widget=resizes-content`；聚焦输入后键盘不遮挡 composer，收起后布局恢复；`--zcode-keyboard-inset` 随键盘状态变化、收起时为 `0px`                                                                                                                                      |
| A4   | iOS Safari 键盘避让      | iOS Safari 真机                                                | 聚焦输入触发 visualViewport resize → 变量写入 → 底部 padding 生效，输入框与发送键可见                                                                                                                                                                                                         |
| A5   | rAF 合并                 | DevTools 连续触发 resize/scroll（visualViewport 存在的环境）   | 同一帧内多次事件只产生一次变量写入（代码断言或断点验证）                                                                                                                                                                                                                                      |
| A6   | 幂等与清理               | 手动 / 单测（jsdom 默认无 visualViewport，覆盖缺失分支）       | 重复 install 不叠加监听；uninstall 后监听移除、变量删除；再次 install 功能恢复；无 visualViewport 时安装/卸载/重复 install 均不抛错、不写变量、不绑定监听                                                                                                                                     |
| A7   | dvh 高度                 | 手机竖屏 / 横屏，工具栏收展与键盘弹起                          | 全屏页 `min-h-dvh` 跟随动态视口，无溢出滚动条、无底部遮挡；移动入口无新增 `min-h-screen`                                                                                                                                                                                                      |
| A8   | 通知中心颜色             | Zai Light / Zai Dark 双主题                                    | 错误信息 `text-destructive`、次要信息 `text-foreground-subtle`；diff 中无新增颜色 token                                                                                                                                                                                                       |
| A9   | touch-2 真机复核         | iOS Safari / Android WebView 真机                              | 复现与否登记到本文 §5 记录块（走查清单落库后同步回填）；本轮代码不包含针对双击缩放的限制性改动                                                                                                                                                                                                |
| A10  | 工具类本体（D2 本轮）    | 代码评审 + DevTools（手机视口）                                | styles.css 中 `.zcode-safe-area-top` / `.zcode-safe-area-bottom` / `.zcode-keyboard-inset-bottom` 定义与 §2.5 表一致（keyboard-inset-bottom 含 `max()` 安全区兜底）；本轮 diff 未引入同层叠加两个底部类的用法；手动改写 `--zcode-keyboard-inset` 后 keyboard-inset-bottom 的 padding 跟随变化 |

## 关联文件

- `packages/web/mobile.html` — viewport meta（D2）。
- `packages/ui/src/lib/mobileKeyboardInset.ts` — 新建，tracker 唯一所有者（D2）。
- `packages/ui/src/index.ts` — tracker 公开导出（D2）。
- `packages/ui/src/styles.css` — 三个安全区/键盘 inset 工具类（D2）。
- `packages/web/src/mobile-remote/main.tsx` — tracker 安装点（D2）。
- `packages/ui/src/MobileNotificationCenter.tsx` — 颜色迁移（D4）。
- `DESIGN.md` — Sizing / Responsive Behavior 增补条目，引用本文。
