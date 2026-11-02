# Round 11 private visual overlay

Private staticlib overlay for the macOS CUA Helper. R9 visual source is pinned
at tree `421530ae2c2cab7b537226e459905916c849c1cf76095db0a45f574f9c49e02e`;
this overlay does not replace the R9 registry, Swift bridge or license files.

## Files

- `include/cua_r11_visual.h` — the only consumer header.
- `src/helper_bridge.rs` — private C ABI copied into
  `crates/cua-macos-visual/src/helper_bridge.rs`.
- `round11-visual.patch` — minimal diff for `Cargo.toml`, `lib.rs`,
  `session.rs` and `capture.rs` (staticlib crate type, operation admission
  hook, final-delivery hook, cancel handle and callback-release notification).

`prepareRound11Visual()` copies the pinned full R9 source, applies the patch
with a per-file hash check, copies `helper_bridge.rs`, and refuses to reuse a
mismatched output. `buildRound11Visual()` runs the fixed Rust 1.97.1 toolchain
with `--locked --offline`, `MACOSX_DEPLOYMENT_TARGET=14.2`, and writes the
`cargo tree`, artifact, patch, header and license hashes under
`output/cua-helper-round11/visual-worker/build/`.

## ABI contract

- `cua_r11_visual_start` rejects a missing/denied callback and an invalid
  request. The callback is invoked at start, Swift admission and final
  delivery; it always receives the stable operation id, never the session
  registry id. A non-zero return denies.
- `cua_r11_visual_cancel` closes result reception and wakes `wait`; it never
  releases callback context. A completed PNG cannot be taken after cancel.
- `cua_r11_visual_callback_resources_released` returns 1 only after Swift
  reported payload hand-back *and* the worker finished every Rust-side
  callback. The final-delivery callback can run after Swift's payload release.
- `cua_r11_visual_destroy` returns `CUA_R11_VISUAL_DESTROY_PENDING` until that
  release condition is met. The Helper keeps callback context alive until then.
- The public R9 `request_window_capture` remains closed with
  `HostNotApproved`; no JSON/SDK/approved-boolean entry is exported.

## Build outputs

- Header: `output/cua-helper-round11/visual-worker/lib/cua_r11_visual.h`
- Staticlib: `output/cua-helper-round11/visual-worker/lib/libcua_macos_visual_round11.a`
- Provenance/build manifest: `output/cua-helper-round11/visual-worker/build/build-manifest.json`

The linked Helper Mach-O must also report `minos 14.2`; Rust std archive
members may report a lower minimum, but no member may exceed 14.2.
