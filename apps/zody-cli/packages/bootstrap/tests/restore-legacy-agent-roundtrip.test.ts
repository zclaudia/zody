import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMessageId, createProjectId, createSessionId, createTurnId } from "@zody/contracts";
import { TASK_INDEX_SCHEMA } from "../../../../../packages/services/src/session/tasksDatabase/schema-v1.js";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";

const restoreScript = fileURLToPath(
  new URL(
    "../../restore-legacy-sessions-plugin/skills/restore-legacy-sessions/scripts/restore-conversation.mjs",
    import.meta.url,
  ),
);

describe("persisted agent identity", () => {
  it("reopens old and explicit message/usage identities and writes restored messages with the new default", async () => {
    const root = await mkdtemp(join(tmpdir(), "r46-agent-roundtrip-"));
    const dbPath = join(root, "sessions.sqlite");
    const tasksPath = join(root, "tasks.sqlite");
    const sessionID = createSessionId("r46-existing");
    const restoredID = createSessionId("r46-restored");
    let store: ReturnType<typeof createSqliteSessionStore> | undefined = createSqliteSessionStore({
      dbPath,
    });
    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("r46"),
        slug: "r46",
        directory: root,
        title: "r46",
        version: "test",
      });
      for (const [index, agent] of ["zcode-agent", "zody-agent", "custom-agent"].entries()) {
        await store.saveMessage({
          id: createMessageId(`r46-${index}`),
          sessionID,
          role: "user",
          time: { created: index + 1 },
          agent,
        });
        await store.recordModelUsage({
          id: `usage-${index}`,
          logicalRequestId: `request-${index}`,
          sessionID,
          turnID: createTurnId(`turn-${index}`),
          querySource: "main_turn",
          providerId: "synthetic",
          modelId: "synthetic",
          status: "completed",
          startedAt: Date.now() + index,
          inputTokens: 1,
          outputTokens: 1,
          computedTotalTokens: 2,
          agent,
        });
      }
      store.close();
      store = createSqliteSessionStore({ dbPath });
      expect((await store.messages({ sessionID })).map((m) => m.info.agent)).toEqual([
        "zcode-agent",
        "zody-agent",
        "custom-agent",
      ]);
      store.close();
      store = undefined;
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(
          db
            .prepare("select agent from model_usage order by id")
            .all()
            .map((r) => r.agent),
        ).toEqual(["zcode-agent", "zody-agent", "custom-agent"]);
      } finally {
        db.close();
      }
      const tasks = new DatabaseSync(tasksPath);
      try {
        tasks.exec(TASK_INDEX_SCHEMA);
        tasks.exec("ALTER TABLE tasks ADD COLUMN searchable_text TEXT NOT NULL DEFAULT ''");
      } finally {
        tasks.close();
      }
      const snapshot = join(root, "snapshot.json");
      await writeFile(
        snapshot,
        JSON.stringify({
          meta: {
            taskId: restoredID,
            workspacePath: root,
            title: "synthetic",
            model: "synthetic",
            createdAt: 1,
            updatedAt: 2,
          },
          messages: [
            { role: "user", content: "old text", timestamp: 1 },
            { role: "assistant", content: "answer", timestamp: 2 },
          ],
        }),
      );
      await promisify(execFile)(
        process.execPath,
        [restoreScript, "--snapshot", snapshot, "--task-index", tasksPath, "--cli-db", dbPath],
        { env: process.env },
      );
      store = createSqliteSessionStore({ dbPath });
      expect((await store.messages({ sessionID: restoredID })).map((m) => m.info.agent)).toEqual([
        "zody-agent",
        "zody-agent",
      ]);
      expect((await store.messages({ sessionID })).map((m) => m.info.agent)).toEqual([
        "zcode-agent",
        "zody-agent",
        "custom-agent",
      ]);
    } finally {
      store?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
