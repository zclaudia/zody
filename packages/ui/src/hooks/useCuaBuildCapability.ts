/**
 * 构建内置 CUA 能力事实的 renderer 侧唯一取数口。
 *
 * 事实所有者是 desktop Main 的 GetCuaCapability（打包产物内 cua-narrow 资源的存在性，
 * 见 specs/computer-use-settings-unification.md）；renderer 不自行推断。查询失败或
 * 返回形状不合法一律按占位处理（fail-closed）。返回 null 表示信号在途，调用方应等待
 * 而不是先渲染另一态——占位卡与开关之间闪跳会被当成界面坏了。
 */
import { useEffect, useState } from "react";
import { DesktopCommandIds, type CuaBuildCapability } from "@zody/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { isCuaBuildCapability } from "@/settings/computerUseAvailability.js";

export function useCuaBuildCapability(): CuaBuildCapability | null {
  const platform = usePlatform();
  const [capability, setCapability] = useState<CuaBuildCapability | null>(null);
  useEffect(() => {
    // Web 端没有 desktop command；设置导航本就不显示该分区，这里按占位兜底。
    if (typeof platform.executeDesktopCommand !== "function") {
      setCapability({ kind: "placeholder" });
      return;
    }
    let cancelled = false;
    void platform
      .executeDesktopCommand(DesktopCommandIds.GetCuaCapability)
      .then((result) => {
        if (!cancelled) {
          setCapability(isCuaBuildCapability(result) ? result : { kind: "placeholder" });
        }
      })
      .catch(() => {
        if (!cancelled) setCapability({ kind: "placeholder" });
      });
    return () => {
      cancelled = true;
    };
  }, [platform]);
  return capability;
}
