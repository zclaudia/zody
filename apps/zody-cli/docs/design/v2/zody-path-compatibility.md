# Zody user and project path compatibility

This spec defines the CLI and service path behavior for the `.zody` product data
root and project configuration migration. It complements the release checklist in
the repository root.

## Product rules

- The only default user data root is `<home>/.zody`. Readers and writers must not
  probe, migrate, or fall back to `<home>/.zcoder` or `<home>/.zcode`.
- At each project/worktree level, `.zody/<relative-resource>` is preferred.
  Resolvers treat only `ENOENT` and `ENOTDIR` as absence; permission, I/O, and
  other filesystem errors from the preferred candidate propagate and must not
  trigger a fallback to `.zcode`. For file config, a present `.zody/config.json`
  suppresses the same-level `.zcode/config.json`; ancestor-to-cwd merge order
  remains unchanged. For directory resources, load distinct names from both roots and let `.zody` shadow
  a same-named `.zcode` resource. A present `.zody` resource is authoritative
  even when empty or invalid; report its error rather than masking it.
- Project writes always target `.zody`. When modifying an existing effective
  `.zcode` config, first preserve its complete JSON object at the `.zody` target,
  then apply the requested patch. Never modify the legacy source file. Hook trust
  records are not copied; the new canonical path and digest use the normal review
  flow.
- Discovery and patching use one shared path/config resolver. Config path choice,
  source ordering, normalization, and canonical workspace identity must agree
  across CLI, bootstrap, services, and hook trust.
- Workspace identity remains `workspaceIdentity?.trim() || workspacePath`. A
  path compatibility decision never changes identity or remote session matching.
- Hook trust remains bound to canonical source path, declaration digest, discovery
  order, and workspace identity. A compatibility filename must be represented in
  `configFileKind` and source-relative provenance so a changed source cannot reuse
  a stale grant.
- Resource-specific subdirectories (skills, MCP config, plugins, commands,
  agents, workflows, permissions and hooks) follow the same directory precedence.
  Their existing schemas, merge order, security checks, and side effects remain
  unchanged.
- Dynamic workflow run entry files are project runtime artifacts and write to
  `.zody/workflow-runs`; the existing OS temp fallback and warning remain intact.
- Saved workflow project definitions, editable drafts, approved plan files, and
  project-scoped persistent agent memory use `.zody` for every write. Existing
  `.zcode` definitions and memory remain read candidates; `.zody` wins by exact
  relative name. Global saved workflows and user-scoped memory use `~/.zody` only.
- A legacy saved workflow is read-only. Update/save creates or replaces the
  canonical `.zody` copy. Delete must fail with a clear read-only-source error
  when the effective definition is legacy-only; deleting a canonical definition
  that would expose a shadowed legacy definition must also fail until an explicit
  tombstone contract exists. No operation reports a successful deletion while
  the workflow remains discoverable.
- Approved plans are read from `.zody/plans` first and `.zcode/plans` only when
  the canonical plan is absent; writes always use `.zody/plans`.
- Project persistent memory uses `.zody/agent-memory/<agent>` and local memory
  uses `.zody/agent-memory-local/<agent>`. If the canonical memory index is
  absent, load the legacy `.zcode` index for the prompt while returning the
  canonical root as the agent's write destination. User memory stays in the
  already configured user storage root under `~/.zody`.
- Hook review mutations lock the canonical `.zody/config.json` path with the
  shared cross-process file lock before re-reading the snapshot, checking its
  digest and workspace identity, and applying the atomic mutation. The in-process
  queue remains an optimization only; correctness comes from the shared file lock.
- CLI debug log and SQLite defaults resolve under `~/.zody/cli`; there is no
  home `.zcode` fallback.

## Ownership and interfaces

The shared path/config discovery layer owns candidate generation and precedence.
Adapters own file parsing and atomic writes. Services and bootstrap consume
resolved candidates and pass the original workspace identity through unchanged.
No caller may add its own `.zody`/`.zcode` fallback list.

For every resource path, discovery yields the selected effective path plus the
write target. The effective path is `.zody` when that candidate exists, otherwise
the existing `.zcode` candidate, otherwise the canonical `.zody` path for a future
write. Config patching from a legacy effective path copies unknown and unrelated
keys before patching, so provider, MCP, skill, plugin, permission and hook values
survive.

## Event order

```text
workspace identity + workspacePath
  -> shared resolver (root-to-cwd candidate order; .zody before .zcode per level)
  -> adapter reads selected effective path
  -> service/bootstrap builds runtime config and trust snapshot
  -> mutation re-resolves under the existing workspace write lock
  -> atomic write to .zody, preserving the selected legacy JSON object first
  -> refresh config/trust snapshot using the same resolver
```

The selected path is captured for each operation. A mutation must re-check the
current candidate under its existing serialization boundary; it must not use a
stale path or write to the legacy file. A changed selected source changes trust
provenance and requires normal re-review.

## Acceptance scenarios

- With only `~/.zcoder` or `~/.zcode` present, user config and user resources are
  treated as absent; all default writes land under `~/.zody`.
- With only project `.zcode/config.json`, it is read; a patch creates
  `.zody/config.json`, preserves unknown and unrelated keys, and leaves the legacy
  file byte-for-byte unchanged.
- With both project config files present, `.zody/config.json` wins for reads and
  writes. An invalid `.zody` file reports an error instead of falling through.
- For same-named skills, MCP config, plugins, commands, agents, workflows,
  permissions, and hook resources, `.zody` wins and legacy is considered only when
  the matching `.zody` resource is absent.
- Saved workflows list and resolve canonical project entries before legacy
  project entries; save writes the canonical path, while delete cannot silently
  leave a discoverable legacy copy.
- Plans and project memory read a legacy-only value on demand and direct future
  writes to the canonical path.
- Concurrent hook review mutations from separate processes serialize on the same
  canonical config lock and revalidate the reviewed snapshot after acquiring it.
- Hook inspection, grant, revoke, reload, and review mutation agree on the
  effective source and preserve exact workspace identity and digest provenance.
- Remote workspace resolution includes both workspace identity and
  `remoteSessionId`; no fallback matches by path alone.
- Paths work with Windows separators and case-insensitive environment keys where
  the existing path API already supports them.

## Out of scope

This spec does not rename the CLI product entry point, desktop branding, Android,
distribution scripts or tool schemas. Internal environment names hard-cut to `ZODY_`; plugin environment and manifest compatibility follow the [rename contract](../../../../../docs/plans/zody-rename-execution/contract-map.md). Hook trust remains bound to the actual source and its original digest: a legacy path is not a new-path approval.
