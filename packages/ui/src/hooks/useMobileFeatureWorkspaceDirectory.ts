import { useEffect, useState } from "react";
import type { WebRemoteControlWorkspaceListResult } from "@zcode/shared";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";

export function useMobileFeatureWorkspaceDirectory(
  switcher: WebRemoteControlWorkspaceSwitcherApi,
  initialWorkspaceList?: WebRemoteControlWorkspaceListResult,
) {
  const [directory, setDirectory] = useState<WebRemoteControlWorkspaceListResult>(
    initialWorkspaceList ?? { workspaces: [] },
  );
  useEffect(() => {
    let active = true;
    void switcher
      .listWorkspaces()
      .then((result) => {
        if (active) setDirectory(result);
      })
      .catch(() => {});
    const off = switcher.onWorkspaceListUpdated?.((result) => {
      if (active) setDirectory(result);
    });
    return () => {
      active = false;
      off?.();
    };
  }, [switcher]);
  return directory;
}
