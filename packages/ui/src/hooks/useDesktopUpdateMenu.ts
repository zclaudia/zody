import { usePlatform } from "@/hooks/usePlatform.js";
import { ZODY_RELEASES_URL } from "@/lib/productDocs.js";

export function useDesktopUpdateMenu(isDesktop: boolean) {
  const platform = usePlatform();
  return {
    visible: isDesktop,
    disabled: false,
    labelId: "titleBar.menu.help.manualUpdate",
    labelValues: undefined,
    openReleases: () => platform.openExternal(ZODY_RELEASES_URL),
  };
}
