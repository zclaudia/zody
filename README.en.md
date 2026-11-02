# Zody

[简体中文](README.md) · English

Zody is an independently maintained fork of Z.AI ZCode: an Electron coding workspace, terminal Agent, Web interface, and Android remote-control app. Configure your own model provider and remote-control gateway. Zody does not operate a hosted model or gateway service.

Version `0.1.0` is the first public preview. Desktop and CLI/Web targets are macOS arm64/x64, Windows x64, and Linux x64. macOS and Windows installers are unsigned. Android release APKs require a dedicated signing key. Availability is shown on [Releases](https://github.com/zclaudia/zody/releases); report problems in [Issues](https://github.com/zclaudia/zody/issues).

## Run a release

Download the matching installer or `zody-cli-<version>-<target>.tar.gz` and verify `SHA256SUMS.txt`. CLI/Web archives include Node.js and native runtime resources. Extract and run `zody/bin/zody` (`zody\bin\zody.cmd` on Windows), or add its `bin` directory to PATH.

```bash
zody --help
zody --version
zody
zody --web --workspace /path/to/project --no-open
```

Web binds to `127.0.0.1` by default. Non-loopback bindings require a token: `--host 0.0.0.0` generates one unless `--token` supplies it; `--no-token` is rejected for these bindings. Direct HTTP entry points accept `ZCODE_SERVER_AUTH_TOKEN`. Configure TLS and access control for network deployments.

Updates are manual downloads from Releases. User data lives under `~/.zody/`; `ZCODE_DATA_BASE_DIR` overrides its parent directory. Old `~/.zcoder/` and `~/.zcode/` user data is not loaded, migrated, or deleted. Project configuration reads `.zody/` first and falls back to `.zcode/`, writing only to `.zody/`. See [configuration compatibility](apps/zody-cli/docs/design/v2/zody-path-compatibility.md). Internal package names, protocol identifiers, and existing `ZCODE_*` environment keys remain internal compatibility interfaces.

## Develop and build

Use Git, Node.js **24.14.0**, and pnpm **10.33.2**, as pinned in `mise.toml`. Run from the repository root:

```bash
pnpm bootstrap
pnpm dev:desktop
pnpm dev:web
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm --dir apps/zody-cli typecheck
pnpm --dir apps/zody-cli lint
pnpm --dir apps/zody-cli test
pnpm bundle:desktop -- --os mac --arch arm64
pnpm build:zody --target darwin-arm64
```

CLI/Web output defaults to `dist/zody/`. Targets: `darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64`; `--all` selects all four. Each target needs matching native assets. SSH/WSL uses bundled runtimes without a remote CDN fallback. Browser Use remains available; unavailable system Computer Use entries are hidden.

See [build and release instructions](docs/fork/build.md) and [Android and gateway setup](docs/mobile-remote-control-android.md). A version tag runs checks and builds a draft Release. Human acceptance precedes publication as a Pre-release. Missing Android signing Secrets or third-party license evidence blocks release; local diagnostic archives are not approved release artifacts.

Zody keeps the original authors’ copyright and the [Apache-2.0 LICENSE](LICENSE). Read [usage and privacy information](NOTICE.md), [third-party notices](THIRD-PARTY-NOTICES.md), and the [0.1.0 specification](specs/zody-0.1.0-release.md).
