# Zody Agent CLI

This directory contains the Agent, TUI, adapters, contracts, and runtime packages maintained as part of Zody. It is included in the repository, not a separate Git submodule. Internal `@zcode/*` package names, plugin identifiers, and protocol names remain compatibility interfaces.

For installation and supported platforms, see the [repository README](../../README.en.md). Public `zody` CLI/Web archives include Node.js and target-native resources; running the source bundle directly still requires the development toolchain.

## Development

Use Node.js 24.14.0 and pnpm 10.33.2 as pinned in the repository root. Run these commands from that root:

```sh
pnpm bootstrap
pnpm --filter @zcode/cli dev --help
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test
pnpm build:zody --target darwin-arm64
```

The source workspace contains `packages/cli`, `packages/tui`, `packages/bootstrap`, `packages/core`, `packages/adapters`, and the workflow and plugin packages. User configuration is stored under `~/.zody/`. Project resources read `.zody` first and fall back to `.zcode`, writing only to `.zody`; see the [path contract](docs/design/v2/zody-path-compatibility.md).

## Plugin Development

zody plugins are local bundles that can contribute skills, custom commands, and MCP servers. The plugin surface is compatible with the Claude Code plugin layout, so existing plugin content can be reused with minimal changes.

Plugin state lives under `~/.zody/cli/plugins`:

- `cache/`: installed marketplace plugin code and static files.
- `data/<plugin-id>/`: persistent plugin data. MCP servers should write runtime output here, not into the plugin source directory.
- `marketplaces/zcode-plugins-official/`: bundled and CDN partitions plus the merged metadata for the single official marketplace.

This repository also ships built-in official plugins as workspace packages. The bundled Browser Use, Document Skills, Skill Creator, and Zody Guide content plugins are default-enabled and appear as `browser-use@zcode-plugins-official`, `document-skills@zcode-plugins-official`, `skill-creator@zcode-plugins-official`, and `zcode-guide@zcode-plugins-official`. Runtime-heavy official plugins such as `ios-simulator@zcode-plugins-official` and `android-emulator@zcode-plugins-official` are discovered by Zody but stay disabled until the user enables them.

```sh
zody plugins list
zody plugins enable ios-simulator
zody plugins disable browser-use
zody plugins enable restore-legacy-sessions
zody plugins disable ios-simulator
```

For local plugin development, put the plugin in any directory, then add it to the user config. Local plugin dirs default to enabled for that config.

```json
{
  "plugins": {
    "enabled": true,
    "dirs": ["/absolute/path/to/my-plugin"]
  }
}
```

### Manifest Compatibility

Zody discovers the first manifest that exists:

1. `.zcode-plugin/plugin.json`
2. `.claude-plugin/plugin.json`

`.zcode-plugin/plugin.json` uses the same field names as Claude Code. Use it only when Zody needs different metadata or runtime wiring. If the Claude manifest already works, a plugin can ship only `.claude-plugin/plugin.json`.

MCP config can live directly in `.zcode-plugin/plugin.json` through `mcpServers`. This is useful when the Claude-compatible `.mcp.json` points at a different runtime, such as Bun source files, while Zody should run a built Node.js server from `dist/`. A plugin may provide both `.mcp.json` and manifest `mcpServers`; when the same server name appears in both places, `mcpServers` from the selected manifest wins.

Supported fields in the current Zody plugin surface:

- `name`, `version`, `description`, `author`, `license`
- `skills`: relative folder or folders containing `SKILL.md` files
- `commands`: relative folder or folders containing markdown custom commands
- `mcpServers`: inline MCP server config, or a relative path to one
- `userConfig`: option defaults used by `${user_config.key}` expansion

Example `.zcode-plugin/plugin.json` with inline MCP config:

```json
{
  "name": "ios-simulator",
  "version": "0.1.0",
  "skills": "skills",
  "commands": "commands",
  "mcpServers": {
    "ios-simulator": {
      "command": "node",
      "args": ["${ZCODE_PLUGIN_ROOT}/dist/mcp/server.js"],
      "cwd": "${ZCODE_PROJECT_DIR}",
      "env": {
        "PLUGIN_DATA": "${ZCODE_PLUGIN_DATA}",
        "DEFAULT_DEVICE": "${user_config.default_device}"
      }
    }
  },
  "userConfig": {
    "default_device": {
      "type": "string",
      "default": "iPhone 16"
    }
  }
}
```

Zody also reads plugin `.mcp.json` using Claude Code's wrapper shape. Use this when the same MCP config should be shared by Claude Code and Zody:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js"]
    }
  }
}
```

Unsupported Claude plugin fields are ignored with diagnostics rather than executed. This includes `hooks`, `agents`, `outputStyles`, `lspServers`, `channels`, and `dependencies`.

### Variables

Plugin MCP config can use both Zody (`ZCODE_*`) and Claude-compatible variable names:

- `${ZCODE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}`
- `${ZCODE_PLUGIN_DATA}` and `${CLAUDE_PLUGIN_DATA}`
- `${ZCODE_PROJECT_DIR}` and `${CLAUDE_PROJECT_DIR}`
- `${user_config.key}`
- `${ZCODE_SOME_ENV}`

Only environment variables with the `ZCODE_` prefix are expanded. Missing variables disable the affected MCP server and produce a plugin diagnostic.

### Recommended Layout

```txt
my-plugin/
  .claude-plugin/plugin.json
  .zcode-plugin/plugin.json
  .mcp.json
  skills/
    my-skill/SKILL.md
  commands/
    my-command.md
  src/
```

Keep reusable content in Claude-compatible locations. Add a `.zcode-plugin/plugin.json` only for Zody-specific package names, built artifacts, or command paths. For MCP servers, prefer Node's normal package build and `bin` output when targeting the Zody CLI, and keep all process/file/network side effects inside the MCP server boundary.

## MCP Configuration

Zody reads MCP servers from the main JSON config. The default user config path is `~/.zody/cli/config.json`; MCP entries live under `mcp.servers`. MCP is enabled by default, so `features.mcp` only needs to be set when you want an explicit on/off switch. The current CLI does not auto-discover standalone `mcp.json` or `.mcp.json` files outside enabled plugins.

```json
{
  "features": {
    "mcp": true
  },
  "mcp": {
    "servers": {
      "filesystem": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
        "cwd": ".",
        "timeoutMs": 30000
      },
      "docs": {
        "type": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": {
          "Authorization": "Bearer <token>"
        }
      },
      "legacy-sse": {
        "type": "sse",
        "url": "https://mcp.example.com/sse",
        "enabled": false
      }
    }
  }
}
```

Supported server types:

- `stdio`: requires `command`; accepts `args`, `cwd`, `env`, `enabled`, and `timeoutMs`. `cwd` is resolved from the active working directory, and the server process inherits Zody's environment plus any `env` overrides.
- `http`: requires `url`; accepts `headers`, `enabled`, and `timeoutMs`.
- `sse`: requires `url`; accepts `headers`, `enabled`, and `timeoutMs`.

MCP tools are registered before the first model request and exposed as `mcp__<server>__<tool>`. Use `/mcp list`, `/mcp status`, `/mcp connect <server>`, and `/mcp disconnect <server>` inside the CLI to inspect or manage configured servers for the current session.

## Hooks Configuration

Zody reads hooks from the same main JSON config file as MCP, usually `~/.zody/cli/config.json`. Hooks are disabled by default; set `hooks.enabled` to `true` and add process hooks under `hooks.events`.

Supported hook events:

- `SessionStart`: runs after session context is initialized and before the first normal prompt reaches the model. It can add context. Its matcher sees the source, such as `startup` or `resume`.
- `UserPromptSubmit`: runs before the user prompt is written to message history or sent to the model. It can block the prompt with `continue: false` or add context. Its matcher sees the raw prompt text.
- `PreToolUse`: runs before a client-side tool executes. It can deny, ask, allow, replace tool input, or add model-visible context. Its matcher sees the tool name.
- `PermissionRequest`: runs when a tool needs approval. It can allow, deny, update permissions, or modify the pending tool input. Its matcher sees the tool name.
- `PostToolUse`: runs after a tool succeeds and before the tool result is returned to the model. It can add context. Its matcher sees the tool name.
- `PostToolUseFailure`: runs after a tool fails and before the failure is returned to the model. It can add recovery context. Its matcher sees the tool name.
- `Stop`: runs when a turn is about to complete without another client-side tool call. It can add feedback and request one more model step with `continue: true`. Empty `continue: true` output is ignored, and repeated continuations are capped to avoid loops.

Example:

```json
{
  "hooks": {
    "enabled": true,
    "timeoutMs": 60000,
    "maxOutputBytes": 32768,
    "events": {
      "SessionStart": [
        {
          "matcher": "startup|resume",
          "hooks": [
            {
              "type": "process",
              "command": "node",
              "args": ["./scripts/session-start-hook.mjs"]
            }
          ]
        }
      ],
      "PreToolUse": [
        {
          "matcher": "^(Bash|Write|Edit)$",
          "hooks": [
            {
              "type": "process",
              "command": "node",
              "args": ["./scripts/pre-tool-hook.mjs"],
              "timeoutMs": 5000
            }
          ]
        }
      ],
      "Stop": [
        {
          "hooks": [
            {
              "type": "process",
              "command": "node",
              "args": ["./scripts/stop-hook.mjs"]
            }
          ]
        }
      ]
    }
  }
}
```

Configuration shape:

- `modelStream.idleTimeoutMs`: initial idle timeout between model SSE events. Defaults to `600000`.
- `hooks.enabled`: enables configured hook execution. Defaults to `false`.
- `hooks.timeoutMs`: default timeout for each hook process. Defaults to `60000`.
- `hooks.maxOutputBytes`: stdout/stderr capture limit for hook processes. Defaults to `32768`.
- `hooks.events.<EventName>`: an array of matcher groups. Groups run in config order.
- `matcher`: optional JavaScript regular expression string. If omitted, the group matches all inputs for that event.
- `hooks`: process hook list for the matcher group. Hooks run in order.
- `type`: currently only `process` is supported.
- `command`: executable to run, using argv execution rather than a shell string.
- `args`: optional argv array.
- `timeoutMs`: optional per-hook timeout override.
- `statusMessage`: optional status label for future UI projection.

Each process hook receives one JSON hook input on stdin and may print one JSON object to stdout. Empty stdout is treated as no-op. Non-JSON stdout, schema-invalid stdout, timeouts, and non-zero exits other than exit code `2` are recorded as hook failures and do not crash the turn by default. Exit code `2` is treated as an explicit block/deny request.

Common stdout examples:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Use the internal API migration checklist for this repository."
  }
}
```

```json
{
  "continue": false,
  "reason": "Do not run destructive shell commands in this workspace.",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Blocked by project hook."
  }
}
```

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "Before finalizing, verify that the answer mentions test coverage."
  }
}
```

## Packaging Strategy

`pnpm build:zody --target <target>` builds the CLI, server, Web, and SEA assets, then assembles a self-contained archive. Supported preview targets are `darwin-arm64`, `darwin-x64`, `win32-x64`, and `linux-x64`. The bundled Node version follows the pinned toolchain and is checked against the official SHA-256 manifest. Native addons, TUI assets, browser runtime files, plugins, and license materials are staged for the selected target.

See [build and release instructions](../../docs/fork/build.md). Local verification archives are marked when license evidence is incomplete; the Release helpers still require the strict license gate before creating or updating a draft. The public entry point is `zody` (`zody.cmd` on Windows), with `zody --web` serving the Web interface.
