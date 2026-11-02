export const REVISION = "2d2f99228d4d2508dc6fcc84c176b296e146714a";
export const SOURCE_ROOT = "libs/cua-driver/rust";
export const PROBE_ROOT = "crates/cua-macos-visual-link-probe";
export const VISUAL_ROOT = "crates/cua-macos-visual";
export function createBaseFiles() {
  return {
    "Cargo.toml": `[workspace]
resolver = "2"
members = [
  "crates/cua-driver-core",
  "crates/cua-driver-sdk",
  "crates/platform-macos",
  "crates/cua-macos-visual",
]

[workspace.package]
version = "0.37.0"
edition = "2021"
license = "MIT"

[workspace.dependencies]
image = { version = "0.25", default-features = false, features = ["png"] }
core-foundation = "0.10"
`,
    "Cargo.lock": `version = 4

[[package]]
name = "core-foundation"
version = "0.10.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

[[package]]
name = "image"
version = "0.25.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

[[package]]
name = "screencapturekit"
version = "8.0.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

[[package]]
name = "cua-driver-core"
version = "0.37.0"

[[package]]
name = "cua-driver-sdk"
version = "0.37.0"
dependencies = [
 "cua-driver-core",
]

[[package]]
name = "platform-macos"
version = "0.37.0"
dependencies = [
 "cua-driver-core",
 "cua-driver-sdk",
]

[[package]]
name = "cua-macos-visual"
version = "0.37.0"
dependencies = [
 "core-foundation",
 "image",
 "screencapturekit",
]
`,
    "crates/cua-driver-core/Cargo.toml": `[package]
name = "cua-driver-core"
version = "0.37.0"
`,
    "crates/cua-driver-core/src/lib.rs": "pub fn old_core() {}\n",
    "crates/cua-driver-sdk/Cargo.toml": `[package]
name = "cua-driver-sdk"
version = "0.37.0"
`,
    "crates/cua-driver-sdk/src/lib.rs": "pub fn old_sdk() {}\n",
    "crates/platform-macos/Cargo.toml": `[package]
name = "platform-macos"
version = "0.37.0"

[features]
default = ["zody-dev-no-input", "zody-strict-frame-gate"]
zody-dev-no-input = []
zody-strict-frame-gate = []
`,
    "crates/platform-macos/src/lib.rs": "pub fn old_capture() {}\n",
    "crates/platform-macos/src/zody_dev_no_input.rs": "pub fn blocked() {}\n",
    "crates/cua-macos-visual/Cargo.toml": `[package]
name = "cua-macos-visual"
version.workspace = true
edition.workspace = true
license.workspace = true
description = "fixture narrow visual crate"
publish = false

[lib]
crate-type = ["rlib"]

[dependencies]
image = { workspace = true }

[target.'cfg(target_os = "macos")'.dependencies]
core-foundation = { workspace = true }
screencapturekit = { version = "8.0.1", features = ["macos_14_2"] }
`,
    "crates/cua-macos-visual/build.rs": `fn main() {
    println!("cargo:rerun-if-changed=src/capture.rs");
}
`,
    "crates/cua-macos-visual/src/capture.rs": `pub fn capture() -> &'static str {
    "screencapturekit generic wrapper"
}
`,
    "crates/cua-macos-visual/src/lib.rs": "pub mod capture;\n",
    "crates/cua-macos-visual/src/swift_link.rs": `pub(crate) fn fixture_link() {}
`,
    "notes/old.txt": "preserve round 8 bytes\n",
  };
}

export function createCandidateFiles(base) {
  return {
    ...base,
    "Cargo.toml": base["Cargo.toml"].replace(
      '  "crates/cua-macos-visual",\n',
      '  "crates/cua-macos-visual",\n  "crates/cua-macos-visual-link-probe",\n',
    ),
    "Cargo.lock": base["Cargo.lock"].replace(
      'name = "cua-macos-visual"\nversion = "0.37.0"\ndependencies = [\n "core-foundation",\n "image",\n "screencapturekit",\n]',
      'name = "cua-macos-visual"\nversion = "0.37.0"\ndependencies = [\n "core-foundation",\n "image",\n]',
    ).concat(`\n[[package]]
name = "cua-macos-visual-link-probe"
version = "0.37.0"
dependencies = [
 "cua-macos-visual",
]
`),
    "crates/cua-macos-visual/Cargo.toml": `[package]
name = "cua-macos-visual"
version.workspace = true
edition.workspace = true
license.workspace = true
description = "fixture narrow visual crate"
publish = false

[lib]
crate-type = ["rlib"]

[dependencies]
image = { workspace = true }

[target.'cfg(target_os = "macos")'.dependencies]
core-foundation = { workspace = true }
`,
    "crates/cua-macos-visual/build.rs": `fn main() {
    println!("cargo:rerun-if-changed=swift/CuaVisualBridge.swift");
}
`,
    "crates/cua-macos-visual/src/capture.rs": `#[link(name = "CuaVisualBridge")]
extern "C" {
    fn cua_visual_capture() -> i32;
}

pub fn capture() -> i32 {
    unsafe { cua_visual_capture() }
}
`,
    "crates/cua-macos-visual/src/lib.rs": `pub mod capture;

pub fn request_capture() -> Result<(), &'static str> {
    Err("HostNotApproved")
}
`,
    "crates/cua-macos-visual/swift/CuaVisualBridge.swift": `import ScreenCaptureKit

@_cdecl("cua_visual_capture")
public func cua_visual_capture() -> Int32 {
    0
}
`,
    [`${PROBE_ROOT}/Cargo.toml`]: `[package]
name = "cua-macos-visual-link-probe"
version.workspace = true
edition.workspace = true
license.workspace = true
publish = false

[dependencies]
cua-macos-visual = { path = "../cua-macos-visual" }
`,
    [`${PROBE_ROOT}/src/main.rs`]: `fn main() {
    let _ = cua_macos_visual::request_capture();
}
`,
  };
}
