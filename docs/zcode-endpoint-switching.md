# ZCode Endpoint Switching

ZCode runtime endpoints are derived from a single origin. The fork ships **no default official
endpoint**: an empty origin means "not configured", and dependent capabilities are disabled or fall
back to built-in values.

The shared resolver (`packages/shared/src/zcodeEndpoint.ts`) defines:

- `DEFAULT_ZCODE_ENDPOINT_ORIGIN` is empty (`""` = unconfigured).
- `TEST_ZCODE_ENDPOINT_ORIGIN` is `https://example.invalid`, an RFC 2606 reserved placeholder used
  only when non-production runs without an explicit env base.
- Production uses `ZCODE_BASE_URL`, `ZCODE_ENDPOINT_ORIGIN` (compatibility fallback), or
  `ZCODE_PRODUCTION_BASE_URL` when set; otherwise it stays unconfigured.
- Non-production prefers the settings override, then the env base, then the placeholder.
- `buildRuntimeZCodeApiUrl` returns `""` when no origin is configured; callers must disable the
  capability instead of requesting a relative URL.

`ZCODE_BASE_URL` is the canonical env variable for the origin. Production builds still ignore
settings overrides; this prevents a stale local setting from moving release builds to a test or
custom endpoint, while keeping release/test deploy targets explicit in env files.

In non-production desktop builds, the Help menu contains `ZCode Endpoint` with these actions:

- `Production (default)` clears the override and returns to the env/default origin (possibly
  unconfigured).
- `Test` stores the `https://example.invalid` placeholder.
- `Custom...` accepts an `http` or `https` origin and normalizes it to `URL.origin`.
- `Reset to Default` clears the override and returns to the env/default origin.

The setting is stored as `zcodeEndpointOrigin` in app settings and only acts as a non-production
temporary override above `ZCODE_BASE_URL`. Changing it rebuilds the menu and stops active web remote
runtimes so the next connection uses the new relay and remote URL. Existing HTTP requests are not
cancelled. `NodeApiClient` no longer rewrites request URLs: callers construct them with the active
endpoint. Telemetry rewrites only its build-time configured report endpoint to the active runtime
origin. Unrelated domains are left untouched, and BYOK provider endpoints (for example the
`api.z.ai` / `open.bigmodel.cn` public API templates) are resolved by provider configuration, not by
this resolver.

For Web dev server, desktop host services, scripts, and CLI testing, set `ZCODE_BASE_URL`, for
example:

```bash
ZCODE_BASE_URL=https://zcode.example.test pnpm --filter @zcode/web dev
ZCODE_BASE_URL=http://localhost:3030 zcode
```

`ZCODE_ENDPOINT_ORIGIN` is still read as a compatibility fallback, but new configs should use
`ZCODE_BASE_URL`.

Android release builds only allow `https://zcode.z.ai/remote`. Debug builds additionally allow
`https://zcode.z.ai/remote` and the existing local/LAN development hosts.
