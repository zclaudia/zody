import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);
const root =
  process.env.MANUAL_TEST_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const large = join(
  root,
  ".agents/skills/zody-large-task-fixture/scripts/generate-large-task-fixture.mjs",
);
const skill = join(
  root,
  "apps/zody-cli/packages/restore-legacy-sessions-plugin/skills/restore-legacy-sessions/scripts",
);
const realHome = resolve(homedir());
const columns = {
  tasks:
    "workspace_key workspace_path workspace_identity task_id title task_status provider mode model migration_source forked_from_task_id created_at updated_at unread_at pinned archived deleted title_overridden searchable_text meta_json",
  session:
    "id project_id workspace_id parent_id trace_id task_type slug directory path title title_source title_message_id version share_url summary_additions summary_deletions summary_files summary_diffs revert permission time_created time_updated time_title_updated time_compacting time_archived",
  message: "id session_id time_created time_updated data",
  part: "id message_id session_id time_created time_updated data",
  todo: "session_id content status priority position time_created time_updated",
  session_entry: "id session_id type time_created time_updated data",
  session_target:
    "session_id target_id objective summary_title status token_budget tokens_used time_used_seconds time_created time_updated",
  model_usage:
    "id logical_request_id attempt_index session_id turn_id trace_id span_id assistant_message_id parent_user_message_id query_source provider_id model_id variant agent mode task_type status started_at first_token_at completed_at duration_ms time_to_first_token_ms finish_reason tool_call_count input_tokens output_tokens reasoning_tokens cache_creation_input_tokens cache_read_input_tokens provider_total_tokens computed_total_tokens retry_count retryable cancelled_by_user context_exceeded error_type error_code error_message raw_usage_json provider_metadata_json",
  turn_usage:
    "session_id turn_id trace_id user_message_id status started_at first_model_start_at first_token_at completed_at duration_ms time_to_first_token_ms model_request_count model_retry_count tool_call_count tool_error_count input_tokens output_tokens reasoning_tokens cache_creation_input_tokens cache_read_input_tokens computed_total_tokens retryable cancelled_by_user context_exceeded error_type error_code",
};

async function init(file, names) {
  await mkdir(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    for (const name of names) {
      const unique =
        name === "tasks"
          ? ", UNIQUE(workspace_key,task_id)"
          : ["session", "message", "part"].includes(name)
            ? ", UNIQUE(id)"
            : "";
      db.exec(
        `CREATE TABLE ${name} (${columns[name]
          .split(" ")
          .map((column) => `"${column}"`)
          .join(",")}${unique})`,
      );
    }
  } finally {
    db.close();
  }
}

function count(file, table) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  } finally {
    db.close();
  }
}

async function hash(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function snapshot(file, id, workspace) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      meta: { taskId: id, workspacePath: workspace, title: "fixture", createdAt: 1, updatedAt: 2 },
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    }),
  );
}

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "zody-manual-path-test-"));
  assert.notEqual(resolve(dir), realHome);
  assert.ok(!resolve(dir).startsWith(realHome + sep));
  const home = join(dir, "home");
  await mkdir(home);
  const task = join(home, ".zody/v2/tasks-index.sqlite");
  const cli = join(home, ".zody/cli/db/db.sqlite");
  const oldTask = join(home, ".zcode/v2/tasks-index.sqlite");
  const oldCli = join(home, ".zcode/cli/db/db.sqlite");
  const cliTables = [
    "session",
    "message",
    "part",
    "todo",
    "session_entry",
    "session_target",
    "model_usage",
    "turn_usage",
  ];
  await init(task, ["tasks"]);
  await init(cli, cliTables);
  await init(oldTask, ["tasks"]);
  await init(oldCli, cliTables);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.MANUAL_TEST_ROOT;
  assert.equal(resolve(env.HOME), resolve(home));
  assert.equal(resolve(env.USERPROFILE), resolve(home));
  assert.notEqual(resolve(home), realHome);
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return { dir, home, task, cli, oldTask, oldCli, env };
}

async function run(context, file, args) {
  assert.ok(resolve(context.env.HOME).startsWith(resolve(context.dir) + sep));
  assert.ok(resolve(context.env.USERPROFILE).startsWith(resolve(context.dir) + sep));
  const { stdout } = await execFileAsync(process.execPath, [file, ...args], {
    cwd: context.dir,
    env: context.env,
  });
  return stdout;
}

test("large fixture generate verify and delete use new HOME databases only", async (t) => {
  const context = await setup(t);
  const oldHashes = await Promise.all([hash(context.oldTask), hash(context.oldCli)]);
  const output = JSON.parse(
    await run(context, large, ["--workspace", context.dir, "--turns", "1"]),
  );
  assert.equal(output.taskIndexPath, context.task);
  assert.equal(output.cliDbPath, context.cli);
  assert.ok(output.backupDir.startsWith(join(context.home, ".zody") + sep));
  assert.equal(
    output.manifestPath,
    join(context.home, ".zody", "perf-task-manifests", `${output.sessionId}.json`),
  );
  await access(output.manifestPath);
  assert.equal(count(context.task, "tasks"), 1);
  assert.equal(count(context.cli, "session"), 1);
  assert.equal(count(context.oldTask, "tasks"), 0);
  assert.equal(count(context.oldCli, "session"), 0);
  const verified = JSON.parse(await run(context, large, ["--verify", output.sessionId]));
  assert.equal(verified.counts.session, 1);
  await run(context, large, ["--delete", output.sessionId]);
  assert.equal(count(context.task, "tasks"), 0);
  assert.equal(count(context.cli, "session"), 0);
  assert.equal(count(context.oldTask, "tasks"), 0);
  assert.equal(count(context.oldCli, "session"), 0);
  assert.deepEqual(await Promise.all([hash(context.oldTask), hash(context.oldCli)]), oldHashes);
});

test("restore reads legacy source, writes new defaults, preserves old stores and honours overrides", async (t) => {
  const context = await setup(t);
  const oldHashes = await Promise.all([hash(context.oldTask), hash(context.oldCli)]);
  const source = join(context.home, ".zcode/v2/sessions/w/legacy.json");
  await snapshot(source, "legacy-id", context.dir);
  const input = await readFile(source, "utf8");
  const beforeDry = await Promise.all([hash(context.task), hash(context.cli)]);
  const dry = await run(context, join(skill, "restore-conversation.mjs"), [
    "--snapshot",
    source,
    "--dry-run",
  ]);
  assert.match(dry, /Dry run mode/);
  assert.deepEqual(await Promise.all([hash(context.task), hash(context.cli)]), beforeDry);
  assert.equal(count(context.task, "tasks"), 0);
  await run(context, join(skill, "restore-conversation.mjs"), ["--snapshot", source]);
  assert.equal(count(context.task, "tasks"), 1);
  assert.equal(count(context.cli, "session"), 1);
  assert.equal(count(context.oldTask, "tasks"), 0);
  assert.equal(count(context.oldCli, "session"), 0);
  assert.equal(await readFile(source, "utf8"), input);
  const scan = JSON.parse(
    await run(context, join(skill, "scan-legacy-sessions.mjs"), [
      "conversations",
      "--agent",
      "unknown",
      "--workspace",
      context.dir,
      "--json",
    ]),
  );
  assert.match(JSON.stringify(scan), /legacy-id/);
  assert.match(JSON.stringify(scan), /ready/);
  const explicit = join(context.dir, "override");
  const task = join(explicit, "tasks.sqlite");
  const cli = join(explicit, "cli.sqlite");
  const source2 = join(explicit, "legacy/w/other.json");
  await init(task, ["tasks"]);
  await init(cli, ["session", "message", "part"]);
  await snapshot(source2, "override-id", context.dir);
  await run(context, join(skill, "restore-conversation.mjs"), [
    "--snapshot",
    source2,
    "--task-index",
    task,
    "--cli-db",
    cli,
  ]);
  assert.equal(count(task, "tasks"), 1);
  assert.equal(count(cli, "session"), 1);
  assert.equal(count(context.task, "tasks"), 1);
  assert.equal(count(context.cli, "session"), 1);
  const scan2 = JSON.parse(
    await run(context, join(skill, "scan-legacy-sessions.mjs"), [
      "conversations",
      "--legacy-dir",
      join(explicit, "legacy"),
      "--task-index",
      task,
      "--cli-db",
      cli,
      "--agent",
      "unknown",
      "--workspace",
      context.dir,
      "--json",
    ]),
  );
  assert.match(JSON.stringify(scan2), /override-id/);
  assert.match(JSON.stringify(scan2), /ready/);
  assert.equal(count(context.oldTask, "tasks"), 0);
  assert.equal(count(context.oldCli, "session"), 0);
  assert.deepEqual(await Promise.all([hash(context.oldTask), hash(context.oldCli)]), oldHashes);
});
