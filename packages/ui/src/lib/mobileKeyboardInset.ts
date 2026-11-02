/**
 * 手机端软键盘 inset 基座，spec 见 docs/web-remote-control/mobile-viewport-input-and-touch.md §2（D2）。
 *
 * Bug 根因（走查 keyboard-1）：iOS Safari 与 Android Chromium 108+（resizes-visual 默认）键盘弹起时
 * 只缩 visual viewport、不缩 layout viewport，`100dvh` 布局不收缩，底部主输入区被键盘覆盖且无任何避让。
 * Android 侧由 mobile.html viewport 的 `interactive-widget=resizes-content` 让 layout viewport 跟随收缩
 * （此时本 tracker 计算结果≈0）；iOS 侧避让完全由本 tracker 承担。
 *
 * 本模块是 CSS 变量 `--zcode-keyboard-inset` 的唯一所有者与唯一写入口：
 * 消费方（工具类 .zcode-keyboard-inset-bottom 等）只读变量，不得自行监听 visualViewport 或直接写该变量。
 * 变量挂在 documentElement 上，生命周期等于页面；运行期不删除（收起写 0px），
 * 仅卸载 tracker 时移除，消费方须用 `var(--zcode-keyboard-inset, 0px)` fallback 兜住未安装态。
 */

const KEYBOARD_INSET_CSS_VARIABLE = "--zcode-keyboard-inset";

/** 当前活动实例的卸载函数；null 表示页面尚无活动 tracker。用于幂等安装（spec §2.4）。 */
let activeUninstall: (() => void) | null = null;

export function installMobileKeyboardInsetTracker(): () => void {
  // 幂等：同一页面已有活动实例时不叠加监听，返回现有实例的卸载函数。
  if (activeUninstall) {
    return activeUninstall;
  }

  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    // 降级分支（老 WebView、jsdom 等无 visualViewport 的环境）：不绑定监听、不计算、不写变量，
    // 返回幂等的安全无操作卸载；消费方走 CSS fallback。安装点在 React 挂载前顶层执行，不能因 tracker 抛错。
    const uninstallNoop = () => {
      if (activeUninstall === uninstallNoop) {
        activeUninstall = null;
      }
    };
    activeUninstall = uninstallNoop;
    return uninstallNoop;
  }

  const root = document.documentElement;
  let rafId: number | null = null;

  // keyboardInset = layout viewport 底边到 visual viewport 底边的距离（键盘高度）；
  // max(0, …) 兜住 offsetTop 平移导致的负值，键盘收起时结果为 0。
  const writeInset = () => {
    const inset = Math.max(0, window.innerHeight - (visualViewport.height + visualViewport.offsetTop));
    root.style.setProperty(KEYBOARD_INSET_CSS_VARIABLE, `${inset}px`);
  };

  // rAF 合并（spec §2.3）：同一帧 resize/scroll 可能连发多次，每帧最多计算一次；
  // 已有待执行帧时直接丢弃后续触发，避免逐事件写变量造成布局抖动。
  const scheduleWrite = () => {
    if (rafId !== null) {
      return;
    }
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      writeInset();
    });
  };

  // 安装时同步写入一次初值，避免首帧读到空值（消费方 calc 依赖变量稳定存在）。
  writeInset();
  // iOS 上聚焦输入、键盘弹起/收起、工具栏收展均表现为 resize/scroll；
  // scroll 覆盖 visual viewport 相对 layout viewport 平移引起的 offsetTop 变化。
  visualViewport.addEventListener("resize", scheduleWrite);
  visualViewport.addEventListener("scroll", scheduleWrite);

  const uninstall = () => {
    // 重复卸载安全：只有当前活动实例才执行清理。
    if (activeUninstall !== uninstall) {
      return;
    }
    activeUninstall = null;
    visualViewport.removeEventListener("resize", scheduleWrite);
    visualViewport.removeEventListener("scroll", scheduleWrite);
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    root.style.removeProperty(KEYBOARD_INSET_CSS_VARIABLE);
  };

  activeUninstall = uninstall;
  return uninstall;
}
