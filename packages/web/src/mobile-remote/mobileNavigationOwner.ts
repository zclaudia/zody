import type { WebRemoteControlMobileNavigationIntent } from "@zody/shared";

export interface MobileNavigationRequest {
  workspaceKey: string;
  taskId?: string;
  intent: WebRemoteControlMobileNavigationIntent;
  search?: { query: string; snippet?: string; snippetIndex?: number };
}

/** Lives in bootstrap, outside disposable React roots. No timers or persistent query history. */
export function createMobileNavigationOwner() {
  let generation = 0;
  let pending: (MobileNavigationRequest & { id: number }) | undefined;
  return {
    begin(request: MobileNavigationRequest) {
      pending = { ...request, id: ++generation };
      return pending;
    },
    peek: () => pending,
    isCurrent: (id: number) => pending?.id === id,
    acknowledge(id: number) {
      if (pending?.id !== id) return undefined;
      const result = pending;
      pending = undefined;
      return result;
    },
    clear() {
      pending = undefined;
      generation += 1;
    },
  };
}
