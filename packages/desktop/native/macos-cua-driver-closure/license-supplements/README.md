# CUA Driver license supplements

This directory contains fixed-version license text that is not present in the locked package archive. The audit remains offline: it verifies the manifest, package metadata, lock checksum, source identity, text bytes and relation against the actual inputs. Nothing here is a legal conclusion or a product-adoption approval.

## Current coverage

The manifest currently holds 22 entries and closes the material gap for the following fixed-version packages.

Workspace packages whose `Cargo.toml` files inherit `license.workspace = true` and `version.workspace = true` from `Cargo.toml` `[workspace.package]` (MIT, version `0.37.0`):

- `cua-driver-contract@0.37.0`
- `cua-driver-core@0.37.0`
- `cua-driver-sdk@0.37.0`
- `cursor-overlay@0.37.0`
- `pip-preview@0.37.0`
- `platform-macos@0.37.0`

The text is the exact `LICENSE.md` blob at fixed CUA revision `2d2f99228d4d2508dc6fcc84c176b296e146714a`: 1069 bytes, SHA-256 `c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9`. Each entry pins the actual candidate `Cargo.toml` SHA-256, the workspace `Cargo.toml` SHA-256, the source repository/commit/path and the full text hash/byte count. The audit independently checks `license.workspace`, `version.workspace`, workspace license/version and repository values; a self-declared evidence string alone is not sufficient.

Registry packages with exact fixed-commit repository-root bodies:

- `block2@0.5.1`, `objc-sys@0.3.5`, `objc2@0.5.2` — `madsmtm/objc2` at `4fc083f1c6d6784577e38b0ee8dbd344481e2fd2`, root `LICENSE.txt`, MIT, 1066 bytes, SHA-256 `e353f37b12aefbb9f9b29490e837cfee05d9bda70804b3562839a3285c1df1e5`.
- `objc2-app-kit@0.2.2`, `objc2-foundation@0.2.2`, `objc2-quartz-core@0.2.2` — `madsmtm/objc2` at `e282618be4c3a3b9542957e0c8540e9588472ce8`, root `LICENSE.txt`, MIT, 1066 bytes, same SHA-256.
- `uniffi@0.31.0`, `uniffi_core@0.31.0`, `uniffi_internal_macros@0.31.0`, `uniffi_macros@0.31.0`, `uniffi_meta@0.31.0`, `uniffi_pipeline@0.31.0` — `mozilla/uniffi-rs` at `309762f55db3f0548194a9ceba3027fa64b18a93`, root `LICENSE`, MPL-2.0, 16725 bytes, SHA-256 `1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5`.
- `jsonschema-regex@0.46.10` — `Stranger6667/jsonschema` at `ecaeceac2340908a8fbf71404442296bd1536520`, root `LICENSE`, MIT, 1075 bytes, SHA-256 `117829c3ca21efb132d81a44b55363d395ab8eea18526873bc828da4c0e5f038`.
- `rquickjs-core@0.14.0` — `DelSkayn/rquickjs` at `d7ef5eeae702fea24c03643064de454f1c1dd4b0`, root `LICENSE`, MIT, 1111 bytes, SHA-256 `976ad3d07927343ab99b31510625acba89eac8e0e517c712925620ddeda91b70`.
- `uuid-simd@0.8.0`, `vsimd@0.8.0` — `Nugine/simd` at `d74c030d9dc4f3cae02146d1f497ff62726ef09a`, root `LICENSE`, MIT, 1062 bytes, SHA-256 `71674605ec4c087fe9eb534e3e4f9e26eb2e4aabcd76a29fd156c6a844d44b3d`.

## Schema

`manifest.json` uses `kind` `zody-cua-driver-closure-license-supplements`, `schemaVersion` 1 and a top-level `sourceRevision`. Each entry binds:

- `name`, `version`, `lockChecksum`
- `cargoTomlSha256`, `cargoVcsSha1`, `cargoVcsInfoSha256`
- `source.repo`, `source.commit`, `source.path`
- `text.path`, `text.sha256`, `text.bytes`
- `relation.kind`, `relation.licenseExpression`, relation evidence and any required workspace digest

Workspace entries use `null` for lock checksum and VCS fields. Registry entries require the lock checksum and must match the actual `.cargo_vcs_info.json` SHA-1 plus its frozen SHA-256. All relation kinds require the actual package repository and commit to agree with the manifest. Text paths must remain inside this directory, must not contain symlinks and must match their pinned hash and byte count.

Only complete recognized license bodies are accepted. Token-only or expression-only files, truncated licenses, code/configuration lookalikes such as `copying.rs` or `copyrights.yml`, and generic notice/copyright files do not close a material gap. `MPL-2.0` remains `reviewRequired` and keeps product adoption blocked even when its full text is present.

## Notice / provenance evidence

`notices/` stores fixed-commit text that is useful provenance but is not a license body. The four `notices/objc2-*-LICENSE.md` files are the byte-identical 1339-byte root `LICENSE.md` from `madsmtm/objc2` commits `b4167b5`, `8852b42`, `7b1abfd` and `8d214f5` (SHA-256 `7f976f7e9cb2d87df7230606feb932c3f21ac0e664045a775b600046ff850c54`). They explain the license selection and the Apple SDK derivation question and link to MIT, Zlib and Apache-2.0, but contain no complete license text. `notices/provenance.json` records the repo/commit/path/hash and affected packages. The fixed-commit tarball enumerations in `notices/objc2-7b1abfd-license-tree.json` and `notices/objc2-other-license-trees.json` show that the license-named file inventory found no complete body for these four commits: the only license-named file is the 1339-byte root `LICENSE.md`; the remaining matches are `copying.rs` source/test and stderr fixture files. This inventory is limited to license/copying-named paths; it does not claim that arbitrary source content contains no license text. These notices are deliberately outside `manifest.json`, so they cannot be counted as license bodies or close `missingMaterials`.

## Pending

The remaining gaps are real and are not filled from `main`, latest releases, sibling crates or short notices:

- 13 `madsmtm/objc2` registry packages have no complete license body at their fixed commits: `block2@0.6.2` (`b4167b5`), `objc2@0.6.4` (`8852b42`), ten `0.3.2` framework crates (`7b1abfd`) and `objc2-encode@4.1.0` (`8d214f5`). The only root file is the pointer/notice preserved under `notices/`, not a body. For all four commits, the frozen license-named file inventory found no complete body; the remaining matches are `copying.rs` source/test and stderr fixture files. The exact-commit `LICENSE-MIT` / `LICENSE-APACHE` / `LICENSE-ZLIB` bodies were not available. These packages also need an Apple SDK derived-material relationship review; they stay missing rather than being forced to pass.
- `siphasher@1.0.2` ships only a 281-byte `COPYING` pointer; its exact-commit `LICENSE-MIT` and `LICENSE-APACHE` were HTTP 404.
- `msvc_spectre_libs@0.1.3` and `shlex@1.3.0` declare `MIT OR Apache-2.0`. Only the MIT body is present; the Apache file is a short notice (shlex `LICENSE-APACHE` is 566 bytes) or absent. These remain `incompleteCoverage` with `Apache-2.0` uncovered and keep the gate blocked.
- `MPL-2.0` text is recorded for the six uniffi packages, but their obligations remain `reviewRequired`; the supplement does not close an MPL policy obligation or enable product adoption.

The offline audit validates every entry against the actual package `Cargo.toml`, lock checksum, `.cargo_vcs_info.json` SHA-1 and file SHA-256, repository and fixed commit. This directory does not invent missing mappings.
