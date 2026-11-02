# CUA Driver Round 9 narrow Swift completion candidate

This directory freezes the R9-N candidate. The source tree, patch, source
manifest and review config are the audit inputs; this README and the reports are
not part of the source tree.

Frozen source root:
`output/cua-driver-round9/native-work/full-source`

## Frozen inputs

- Base R8 tree: `4cbad8776947504f9883bf5370d6802177090d7a01075c5640b64a730950d9de`
- Base R8 source manifest: `../round8/source-manifest.json`
  - SHA-256: `2e6311683b23ed5d33470202d70fcaab313a60fe0fae01b116c3408a19f905bb`
  - 767 files
- Candidate source tree: `421530ae2c2cab7b537226e459905916c849c1cf76095db0a45f574f9c49e02e`
- Candidate source manifest: `source-manifest.json`
  - SHA-256: `939fee8c3ad251cba055bb97b917f130b74a876797c9228a7e0c7c20695144e3`
  - 776 files: 710 upstream-selected, 38 modified, 66 added, 0 removed
- Candidate patch: `candidate-source.patch`
  - SHA-256: `2d4629a8985c59200fb4df5367d9b86ffdbaf4d7def49fccbd60201458a266da`
  - 117,293 bytes; applies to the frozen R8 tree byte-for-byte
- Review config: `review-config.json`
  - SHA-256: `3f49c8358c5b17ed244da9d795a7eee5f41cbb4c7f584f136db3d19617b46c5b`

### Provenance scopes (important)

The existing closure audit CLI expects `allowedDelta` to be the full
upstream-to-candidate provenance, not an incremental round delta. Accordingly:

- top-level `allowedDelta` is the FULL upstream-to-R9 delta: 38 modified and 66
  added paths, 0 removed; `expected` is 710 selected / 38 changed / 66 added /
  776 candidate files.
- `r8ToR9Delta` in the same config is the incremental R8-to-R9 delta: 10
  modified and 9 added paths. The round9 prepare tool independently derives this
  incremental delta from the R8 and R9 manifests, so the two scopes do not
  replace each other.

The config retains the required audit provenance fields (`upstreamLicensePath:
LICENSE.md`, `licensePolicy`, `workspaceExternalMembers: []`) plus the R8 base
pins and candidate pins.

## What R9 changes

- Replaces this crate's dependency on the general `screencapturekit` wrapper
  with a narrow Swift completion bridge derived from the fixed SCK 8.0.1
  sources. The archive checksum, git revision, per-source-file SHA-256, retained
  MIT/Apache texts and the derived delta are in
  `crates/cua-macos-visual/native/DERIVATION.md`.
- Keeps real `SCShareableContent` exact `windowID`/PID/layer/bounds selection,
  `SCContentFilter(desktopIndependentWindow:)`, `SCStreamConfiguration`
  (`showsCursor=false`, explicit `kCVPixelFormatType_32BGRA`) and
  `SCScreenshotManager.captureImage` completion. RGBA and pixel budgets are
  checked before the capture call.
- `LifecycleGate` has distinct once-only enumeration, admission, capture-start,
  capture-completion and terminal claims. The capture-completion claim happens
  at callback entry before validation/render, so a duplicate framework callback
  cannot allocate/render after capacity was released.
- `src/session.rs` owns a four-slot bounded registry, monotonic reception
  cancellation, a cloneable cancel handle, one-shot `wait`, and idempotent
  completion/release. Observer `Drop` closes reception; a slot is released only
  by Swift's `payload_released` after the bridge-owned pixel buffer is gone.
- `src/observe.rs` adds a final cancellation check after PNG verification. That
  check is the result-delivery linearization point.
- New independent consumer `crates/cua-macos-visual-link-probe`: it owns its
  own `-isysroot`/syslibroot, `/usr/lib/swift` rpath and 14.2 deployment gate,
  and retains the real bridge object with `black_box` without exposing a native
  execution address.

The general wrapper's stream/recording/audio/picker/Metal-texture code and the
`apple-metal`/`apple-cf` crate dependencies are not in this crate's target
graph. The retained `-framework Metal` / `-lswiftMetal` entries are system
SDK/overlay autolinks, not the removed wrapper; system ScreenCaptureKit may
still use Metal internally.

## Target graph

`cargo tree -p cua-macos-visual-link-probe` for this tree contains the probe,
`cua-macos-visual`, `core-foundation`, `image`/PNG and their pure Rust
dependencies. It contains no `screencapturekit`, `apple-metal` or `apple-cf`.

The lock still retains those old package entries/checksums because the old
SDK/platform roots still use them. The visual lock package changed only from
`core-foundation,image,screencapturekit` to `core-foundation,image`; the probe
is a new path package with no source/checksum. No other lock package changed
and no package was removed.

## Toolchain and Mach-O evidence

- Rust: fixed `output/cua-driver-round6/rustup/toolchains/1.97.1-aarch64-apple-darwin`.
- Swift: `/Library/Developer/CommandLineTools/usr/bin/swiftc`, Apple Swift 6.4
  (`swiftlang-6.4.0.34.1 clang-2100.3.34.1`).
- SDK: explicit `macosx27.0`,
  `/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk`, version `27.0`.
- Swift flags: `-parse-as-library -emit-object -swift-version 5 -O
  -target arm64-apple-macos14.2 -sdk <SDK>`; exit 0 with empty stderr.
- Built Swift object: `LC_BUILD_VERSION platform 1, minos 14.2, sdk 27.0`.
- Consumer/probe: `minos 14.2`, `sdk 27.0`, `LC_RPATH=/usr/lib/swift`,
  external `_cua_visual_capture_window`, and no
  `libswiftCompatibility*` dynamic dependency.
- The object's real autolink includes ScreenCaptureKit, Foundation,
  CoreFoundation, CoreGraphics, CoreVideo, Metal and Swift overlays such as
  `swiftMetal`, `swiftAVFoundation`, `swiftCoreAudio`, `swiftCoreImage` and
  `swiftCoreMIDI`. It does not force-load `libswiftCompatibility56` or
  `libswiftCompatibilityPacks`, so the build does not require those archives.

An earlier local attempt pinned `macosx15.2` after a non-reproducible compiler
diagnostic. Full-bridge builds with SDK 27.0 then succeeded (controller-run and
repeated locally with exit 0/empty stderr). This candidate does not claim SDK 27
is incompatible with Swift 6.4; the 15.2 pin was a misdiagnosis and is not used.

## Tests run (no OS capture)

```bash
cd /Users/zhvala/SourceCode/zody/output/cua-driver-round9/native-work/full-source
TOOL=/Users/zhvala/SourceCode/zody/output/cua-driver-round6/rustup/toolchains/1.97.1-aarch64-apple-darwin/bin
PATH=$TOOL:/Users/zhvala/.local/share/fnm/node-versions/v24.14.0/installation/bin:$PATH \
CARGO_HOME=/Users/zhvala/SourceCode/zody/output/cua-driver-round9/native-work/cargo-home \
CARGO_TARGET_DIR=/Users/zhvala/SourceCode/zody/output/cua-driver-round9/native-work/target \
MACOSX_DEPLOYMENT_TARGET=14.2 RUSTC=$TOOL/rustc \
$TOOL/cargo test -p cua-macos-visual --lib --test pure_visual \
  --locked --offline --target aarch64-apple-darwin
```

Result: 34 library tests + 16 integration tests = 50 passed, 0 failed. These
cover cancel-before/after-admission, drop-before-admit, duplicate
admission/callback/close/release, bounded capacity, late payload, final-delivery
cancel, one-shot wait, a two-thread wait/cancel wakeup, and the public
`HostNotApproved` refusal.

```bash
cd /Users/zhvala/SourceCode/zody/output/cua-driver-round9/native-work/full-source/crates/cua-macos-visual-link-probe
PATH=$TOOL:/Users/zhvala/.local/share/fnm/node-versions/v24.14.0/installation/bin:$PATH \
CARGO_HOME=/Users/zhvala/SourceCode/zody/output/cua-driver-round9/native-work/cargo-home \
CARGO_TARGET_DIR=/Users/zhvala/SourceCode/zody/output/cua-driver-round9/native-work/target \
RUSTC=$TOOL/rustc \
$TOOL/cargo build -p cua-macos-visual-link-probe --release --locked --offline \
  --target aarch64-apple-darwin
MACOSX_DEPLOYMENT_TARGET=14.2 \
  /Users/zhvala/SourceCode/zody/output/cua-driver-round9/native-work/target/aarch64-apple-darwin/release/cua-macos-visual-link-probe
```

Result: exit 0, `diagnostic=cua-macos-visual/r9-swift-completion`,
`public_capture=HostNotApproved`, `native_capture_invoked=false`. The probe must
be built from its own directory so its `.cargo/config.toml` supplies
`MACOSX_DEPLOYMENT_TARGET=14.2`; the build fails closed otherwise.

## Scope limits

- The probe is a pure link/start consumer, not the diagnostic Helper. The
  existing diagnostic Helper target is macOS 12.0 and cannot automatically
  consume this minimum-14.2 probe; no Helper wiring or authorization is added.
- No real window enumeration, screenshot, ScreenCaptureKit capture, input,
  permission/TCC request, certificate action or UI grant was executed. Passing
  link/start and pure tests is not native capture acceptance.
- `request_window_capture` remains `HostNotApproved`; the internal native
  functions are not a public execution API and no success stub exists.
- Cancelling reception is not native stop. A capture already admitted in Swift
  may still start and its late result is dropped; a missing callback keeps the
  slot and wait pending because no timeout is added.
- `payload_released` means the bridge-owned pixel storage and C callback borrow
  were handed back. It does not prove the OS callback thread has exited and is
  not native `Fenced`/`Drained` evidence.
- No identity/submission/lease mirror, approved boolean or public token is
  introduced.

