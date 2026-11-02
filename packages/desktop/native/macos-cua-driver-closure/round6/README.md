# Round 6 Driver cache and toolchain closure

This directory freezes only the explicit Round 6 preparation inputs. It does not
replace the Round 5 `review-config.json`; its historical `auditedVersion` 1.93.1
and the diagnostic Helper pin remain unchanged.

## Fixed toolchain

`toolchain.json` pins Rust 1.97.1 for `aarch64-apple-darwin`, rustc commit
`8bab26f4f68e0e26f0bb7960be334d5b520ea452`, cargo commit
`c980f4866141969fab6254a680546a277789d6f0`, binary SHA-256 values, and the
official channel manifest SHA-256
`03569b1886ceb5c05276b50c8431ab111de944cd6140fe1fa7d821dd8e0f29cf`.

The controller prepares the toolchain in the project independent ignored output directory:

```text
output/cua-driver-round6/rustup/toolchains/1.97.1-aarch64-apple-darwin
```

The audit requires `--toolchain-root` and invokes only absolute
`<root>/bin/rustc` and `<root>/bin/cargo` paths. It verifies release, commit,
host, sysroot identity, and binary digests. Missing or drifted paths are blocked;
there is no stable fallback. This audit never installs Rust or changes the user's
default toolchain.

## Cache reconstruction

`--rebuild-cache` copies `registry/cache` and `registry/index` into an owned empty
staging directory, verifies every locked archive checksum from the copy, and then
rebuilds registry sources from verified archives. Reconstructed files are
compared byte-for-byte, including `Cargo.lock`, and tree digests include size and
mode. `.cargo-ok` is recorded as a Cargo marker, not crate content.

The original cache is never rewritten. All original source differences are
recorded under `originalCache`; only `reconstructedCache` and the actual
`cua-driver-sdk` macOS target graph can pass. Archives absent from `Cargo.lock`
are listed as excluded and are not extracted or executed. A known vendored path
replacement, such as `vendor/core-graphics` for `core-graphics-0.24.0`, is
recorded explicitly; the frozen Round 5 manifest remains authoritative for the
two reviewed vendor file differences.

Missing target-graph archives, unsafe archive entries (absolute/traversal paths,
links, duplicate or non-regular entries, oversized members), original source
symlinks, and checksum failures are fail-closed.

## Optional build evidence

Both build flags require the explicit `--toolchain-root` and `--rebuild-cache`; they
never fall back to stable and never compile from the original cache.
`--check-build` runs `cargo check`; `--build-library` runs `cargo build` for
`cua-driver-sdk --lib` with `--locked --offline --target aarch64-apple-darwin`.
Both use only the reconstructed cache, a private `HOME`, `TMPDIR`, `CARGO_HOME`,
and target directory, with no credentials. Cargo itself runs `--locked --offline`,
so Cargo has no network fallback; this is not an OS sandbox, and build-script or
proc-macro OS network access is not claimed to be denied. The report records
actual build-script execution, compiled proc-macro set, platform SDK/clang evidence, and artifact hashes. The SDK rlib
and cdylib are preserved under `build-artifacts/`.

Build evidence is not product acceptance: no upstream application or test is
started. Product adoption, signing, TCC, native Helper/Fenced behavior, Intel and
minimum-macOS coverage remain blocked/separate.

## License supplements

`--license-supplements <path>` is explicit only; no default is auto-loaded. When
provided it is forwarded with the real lock packages and the fixed source revision. Material coverage and obligation-review-pending remain
separate. Supplement parsing and license-source support are owned by the separate
license-library worker.
