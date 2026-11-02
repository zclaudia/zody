# CUA Driver Round 8 visual-root candidate

This directory freezes the R8-N candidate. The source tree, patch, source
manifest and review config are the review inputs; this README is not part of the
candidate source tree.

This is the format-only final version: the new crate's Rust files were formatted
with the pinned `rustfmt 1.9.0-stable` from toolchain 1.97.1. No old source was
formatted and no semantics were changed by the formatting pass.

## Frozen inputs

- Source tree: `output/cua-driver-round8/native-work/full-source`
- Source manifest: `source-manifest.json`
  - SHA-256: `2e6311683b23ed5d33470202d70fcaab313a60fe0fae01b116c3408a19f905bb`
  - tree SHA-256: `4cbad8776947504f9883bf5370d6802177090d7a01075c5640b64a730950d9de`
  - 767 files: all 753 R7 paths retained, 14 new files and two root files modified.
    Relative to the fixed upstream selection: 57 added, 38 modified, 672 unchanged
- Candidate patch: `candidate-source.patch`
  - SHA-256: `9117756a71b9324cd0444848692a973a3c86972e9f8763470f6c5c5c529f9ed8`
  - 85,499 bytes; 16 diff headers (root `Cargo.lock`/`Cargo.toml` plus 14
    `crates/cua-macos-visual/**` files); no deletion
- Review config: `review-config.json`
  - SHA-256: `4f54251b2eca301106d7f0600d9d86f4f0855fcde91d8bd3c937d0deab2cc58b`
  - base manifest `../round7/source-manifest.json`, SHA-256
    `53fc08d9835f27c07ae756f93a345b9d0a0cf6d9197aa01db03796fc605f5267`
  - base tree `f110f6466d06036ff9a028c7e35bd4f3b6fe312b67607c2a3f930f1c250f8d48`
  - package `cua-macos-visual`, target `aarch64-apple-darwin`, toolchain `1.97.1`

The patch is based on the frozen R7 tree, not on the historical 752-file or
upstream tree. The `prepareRound8Candidate` verifier rebuilds the 767-file tree
from the R7 base, applies this patch byte-for-byte and checks the tree hash,
manifest delta and dependency policy.

## Graph and license status

The controller independently rebuilt and audited the final tree
`4cbad8776947504f9883bf5370d6802177090d7a01075c5640b64a730950d9de` on
2026-10-29. The actual graph contains 30 packages (29 registry and one local
visual crate), 8 build-script packages, 0 proc-macro packages and no missing or
partial package license materials. The locked/offline arm64 library build passed;
two real Mach-O pure-test programs linked and started, with 16 unit and 16
integration tests passing. No native Computer Use function was invoked.

This graph replaces the review root, not the SDK's functionality or ABI. The old
SDK's 13 missing and one partial license-material findings remain unresolved on
that old graph. See [controller acceptance](../reports/2026-10-28-round8/ACCEPTANCE.md)
for the final evidence, failed intermediate attempts and remaining product gates.

No license supplement manifest is requested for R8: 0 entries. The new graph's
62 package-embedded license bodies cover all 30 packages, so there is no mapping
to retain or add. The existing supplement loader rejects an empty `entries`
array, and the comparison tool reports `not-requested` when no candidate
supplement path is supplied. The new crate carries its own `LICENSE-MIT`, a
verbatim copy of the fixed upstream root `LICENSE.md` at revision
`2d2f99228d4d2508dc6fcc84c176b296e146714a`: 1,069 bytes, SHA-256
`c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9`.

## Swift runtime link note

`crates/cua-macos-visual/build.rs` adds
`cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift` for this crate's test/final
executable. The upstream Swift objects reference the system Swift runtime via
`@rpath`; the compatibility-library search path alone does not satisfy runtime
loading. This uses the standard system runtime directory, not
`DYLD_LIBRARY_PATH`, a copied library or disabled validation. An `rlib` does not
carry this runtime closure, so a future Helper consumer must put the same rpath
on its own final executable.

## Controller verification

```bash
cd /Users/zhvala/SourceCode/zody/output/cua-driver-round8/candidate-work/controller-accepted/full-source
PATH=/Users/zhvala/.local/share/fnm/node-versions/v24.14.0/installation/bin:$PATH \
CARGO_HOME=/Users/zhvala/SourceCode/zody/output/cua-driver-round8/controller-accepted-pure-tests/cache/cargo-home \
/Users/zhvala/SourceCode/zody/output/cua-driver-round6/rustup/toolchains/1.97.1-aarch64-apple-darwin/bin/cargo test \
  -p cua-macos-visual --lib --test pure_visual \
  --locked --offline --target aarch64-apple-darwin
```

This exercises only the crate's reviewed pure tests; the public capture request
still always returns `HostNotApproved`, and no native enumeration, ScreenCaptureKit
capture, permission, TCC, input or UI path is started. An earlier pre-rpath tree
linked but aborted at dyld on `@rpath/libswift_Concurrency.dylib`; that failure
is retained in `output/cua-driver-round8/controller-final-pure-tests/` and is not
the final result. After the rpath fix, tree `43fb7585...` linked, started and
passed 32 pure tests; the formatted `4cbad877...` tree then independently passed
the same 32 tests. Final logs are in the acceptance archive.
