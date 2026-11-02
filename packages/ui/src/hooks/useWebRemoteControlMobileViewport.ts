import { useEffect, useState } from "react";

export const WEB_REMOTE_CONTROL_MOBILE_QUERY = "(max-width: 767px)";

function readMobileViewport(enabled: boolean): boolean {
  return (
    enabled &&
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(WEB_REMOTE_CONTROL_MOBILE_QUERY).matches
  );
}

/** Web Remote Control 的手机视口唯一判定；普通窄桌面窗口不启用手机导航。 */
export function useWebRemoteControlMobileViewport(enabled = true): boolean {
  const [isMobileViewport, setIsMobileViewport] = useState(() => readMobileViewport(enabled));

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      setIsMobileViewport(false);
      return;
    }

    const mediaQueryList = window.matchMedia(WEB_REMOTE_CONTROL_MOBILE_QUERY);
    const syncMobileViewport = () => setIsMobileViewport(mediaQueryList.matches);
    syncMobileViewport();
    if (typeof mediaQueryList.addEventListener === "function") {
      mediaQueryList.addEventListener("change", syncMobileViewport);
      return () => mediaQueryList.removeEventListener("change", syncMobileViewport);
    }

    mediaQueryList.addListener(syncMobileViewport);
    return () => mediaQueryList.removeListener(syncMobileViewport);
  }, [enabled]);

  return isMobileViewport;
}
