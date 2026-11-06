import { join } from "node:path";
import {
  CoreErrorType,
  PLAN_MODE_MAX_PLAN_CHARS,
  createCoreError,
  isFileSystemPortError,
  type FileSystemPort,
  type SessionId,
  type TraceContext,
} from "@zody/contracts";
import { resolveProjectResourceRoots } from "@zody/shared/zody-paths";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

const PLAN_FILE_REFERENCE_MAX_BYTES = PLAN_MODE_MAX_PLAN_CHARS * 4 + 1024;

export function resolveApprovedPlanFilePath(input: {
  sessionId: SessionId | string;
  workspaceRoot: string;
}): string {
  return join(
    resolveProjectResourceRoots(input.workspaceRoot, "plans").writePath,
    `plan-${sanitizePlanFileSessionId(input.sessionId)}.md`,
  );
}

export async function writeApprovedPlanFile(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  plan: string;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<{ path: string }> {
  if (!input.plan.trim()) {
    throw createCoreError(CoreErrorType.InvalidInput, "ExitPlanMode plan cannot be empty", {
      recoverable: true,
    });
  }

  const path = resolveApprovedPlanFilePath(input);
  await input.fileSystemPort.writeTextFile(
    {
      atomic: true,
      content: input.plan,
      createParents: true,
      encoding: "utf8",
      path,
      trace: input.traceContext,
    },
    { signal: input.abortSignal },
  );
  return { path };
}

export async function readApprovedPlanFileReferenceEntry(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<RuntimeMessageEntry | undefined> {
  let content: string;
  let path = resolveApprovedPlanFilePath(input);
  try {
    const read = await input.fileSystemPort.readTextFile(
      {
        maxBytes: PLAN_FILE_REFERENCE_MAX_BYTES,
        path,
        trace: input.traceContext,
      },
      { signal: input.abortSignal },
    );
    content = read.content;
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") {
      const legacyPath = join(
        resolveProjectResourceRoots(input.workspaceRoot, "plans").legacyPath,
        `plan-${sanitizePlanFileSessionId(input.sessionId)}.md`,
      );
      try {
        const read = await input.fileSystemPort.readTextFile(
          {
            maxBytes: PLAN_FILE_REFERENCE_MAX_BYTES,
            path: legacyPath,
            trace: input.traceContext,
          },
          { signal: input.abortSignal },
        );
        path = legacyPath;
        content = read.content;
      } catch (legacyError) {
        if (isFileSystemPortError(legacyError) && legacyError.code === "not_found") {
          return undefined;
        }
        throw legacyError;
      }
    } else {
      throw error;
    }
  }

  if (!content.trim()) return undefined;
  return systemReminderAttachmentEntry(
    "plan_file_reference",
    formatPlanFileReference({ planContent: content, planFilePath: path }),
  );
}

export function formatPlanFileReference(input: {
  planContent: string;
  planFilePath: string;
}): string {
  return [
    `A plan file exists from plan mode at: ${input.planFilePath}`,
    "",
    "Plan contents:",
    "",
    input.planContent,
    "",
    "If this plan is relevant to the current work and not already complete, continue working on it.",
  ].join("\n");
}

function sanitizePlanFileSessionId(sessionId: SessionId | string): string {
  const sanitized = String(sessionId)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      "Session id cannot produce a plan file name",
      {
        recoverable: false,
      },
    );
  }
  return sanitized;
}
