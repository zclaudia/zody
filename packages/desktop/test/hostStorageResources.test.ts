import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { validateHostStorageResources } from "../src/host/hostStorageResources.js";

function snapshot(source: string) {
  return {
    sha256: createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex"),
    source,
  };
}

it("verifies embedded storage sources and exposes data ESM Worker URLs", () => {
  const resources = validateHostStorageResources({
    tasksStorageWorker: snapshot("export const kind = 'tasks';"),
    sessionStorageEntry: snapshot("export const kind = 'session';"),
  });
  expect(resources.tasksStorageWorker.workerUrl.protocol).toBe("data:");
  expect(resources.sessionStorageEntry.workerUrl.protocol).toBe("data:");
  expect(Object.isFrozen(resources.tasksStorageWorker)).toBe(true);
});

it("rejects a snapshot whose bytes do not match its pinned digest", () => {
  expect(() =>
    validateHostStorageResources({
      tasksStorageWorker: { sha256: "0".repeat(64), source: "export {};" },
      sessionStorageEntry: snapshot("export {};"),
    }),
  ).toThrow(/tasksStorageWorker digest mismatch/);
});
