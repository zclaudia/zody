import { useZodyStoreWithDefault } from "@/store/StoreProvider.js";

export function useIsOfficeMode(): boolean {
  return useZodyStoreWithDefault((state) => state.interfaceMode === "office", false);
}
