import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDesktopUpdateMenu } from "@/hooks/useDesktopUpdateMenu.js";

const mocks = vi.hoisted(() => ({
  platform: {
    getUpdateState: vi.fn(),
    onUpdateStateChanged: vi.fn(),
    executeDesktopCommand: vi.fn(),
    openExternal: vi.fn(),
  },
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => mocks.platform }));

let latest: ReturnType<typeof useDesktopUpdateMenu>;
function Probe({ desktop }: { desktop: boolean }) {
  latest = useDesktopUpdateMenu(desktop);
  return null;
}
function render(desktop = true) {
  renderToStaticMarkup(createElement(Probe, { desktop }));
}
afterEach(() => vi.clearAllMocks());

describe("Zody 手动更新入口", () => {
  it("始终打开 Zody Releases，不查询或触发应用内更新", () => {
    render();
    expect(latest.visible).toBe(true);
    expect(latest.disabled).toBe(false);
    expect(latest.labelId).toBe("titleBar.menu.help.manualUpdate");
    latest.openReleases();
    expect(mocks.platform.openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://github.com/zclaudia/zody/releases",
    );
    expect(mocks.platform.getUpdateState).not.toHaveBeenCalled();
    expect(mocks.platform.onUpdateStateChanged).not.toHaveBeenCalled();
    expect(mocks.platform.executeDesktopCommand).not.toHaveBeenCalled();
  });

  it("Web 与手机远控不显示桌面更新入口", () => {
    render(false);
    expect(latest.visible).toBe(false);
  });
});
