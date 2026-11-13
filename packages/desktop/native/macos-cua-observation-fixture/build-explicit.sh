#!/bin/bash
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)"
if [[ $# != 1 || "$1" != /* || ! -d "$1" ]]; then
  echo 'expected existing absolute build directory' >&2; exit 2
fi
out="$1"
cxx=(xcrun clang++ -std=c++17 -fobjc-arc -Wall -Wextra -Werror -Wno-unused-function -O1)
"${cxx[@]}" -framework Foundation "$src/contract_test.mm" -o "$out/contract-test"
"$out/contract-test"
"${cxx[@]}" -framework AppKit -framework CoreGraphics "$src/preflight.mm" -o "$out/fixture-preflight"
"$out/fixture-preflight" --self-test
"${cxx[@]}" -framework AppKit "$src/explicit_contract_test.mm" "$src/explicit_surface.mm" -o "$out/explicit-contract-test"
"$out/explicit-contract-test"
"${cxx[@]}" -framework Foundation "$src/explicit_manifest_test.mm" "$src/explicit_manifest.mm" -o "$out/explicit-manifest-test"
"$out/explicit-manifest-test"
"${cxx[@]}" -framework AppKit "$src/explicit_control_test.mm" "$src/explicit_control.mm" -o "$out/explicit-control-test"
"$out/explicit-control-test"
"${cxx[@]}" -framework AppKit "$src/explicit_control_main.mm" "$src/explicit_control.mm" -o "$out/fixture-control"
"${cxx[@]}" -framework AppKit "$src/explicit_fixture.mm" "$src/explicit_surface.mm" "$src/explicit_manifest.mm" -o "$out/explicit-observation-fixture"
"${cxx[@]}" -framework Foundation -framework ApplicationServices -framework IOKit "$src/lock-monitor.mm" -o "$out/lock-monitor"
app="$out/ZodyExplicitObservationFixture.app"
mkdir -p "$app/Contents/MacOS"
cp "$out/explicit-observation-fixture" "$app/Contents/MacOS/explicit-observation-fixture"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>org.zody.cua.explicit-observation-fixture</string>
  <key>CFBundleExecutable</key><string>explicit-observation-fixture</string>
  <key>CFBundleName</key><string>Zody Explicit Observation Fixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
</dict></plist>
PLIST
