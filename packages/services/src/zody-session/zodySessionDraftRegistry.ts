import type { ZodySessionStateSnapshot } from "@zody/shared";
import type {
  ZodySessionWorkspaceTarget,
  ZodyTaskTarget,
} from "#src/zody-session/zodySession.js";

function getWorkspaceKey(target: ZodySessionWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function getSessionScopedKey(target: ZodyTaskTarget): string {
  return `${getWorkspaceKey(target)}\0${target.sessionId}`;
}

export function createZodyDeferredDraftRegistry() {
  const sessionKeys = new Set<string>();

  return {
    remember(params: ZodySessionWorkspaceTarget, snapshot: ZodySessionStateSnapshot): void {
      sessionKeys.add(
        getSessionScopedKey({
          workspacePath: snapshot.session.workspace.workspacePath,
          workspaceIdentity:
            snapshot.session.workspace.workspaceIdentity ?? params.workspaceIdentity,
          sessionId: snapshot.session.sessionId,
        }),
      );
    },

    has(target: ZodyTaskTarget): boolean {
      return sessionKeys.has(getSessionScopedKey(target));
    },

    forget(target: ZodyTaskTarget): void {
      sessionKeys.delete(getSessionScopedKey(target));
    },
  };
}
