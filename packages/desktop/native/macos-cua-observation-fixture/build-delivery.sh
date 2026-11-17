#!/bin/bash
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)"
if [[ $# != 1 || "$1" != /* || ! -d "$1" ]]; then
  echo 'expected existing absolute build directory' >&2; exit 2
fi
out="$1"
cxx=(xcrun clang++ -std=c++17 -fobjc-arc -Wall -Wextra -Wno-unused-function -O1)
"${cxx[@]}" -framework Foundation "$src/contract_test.mm" -o "$out/contract-test"
"$out/contract-test"
"${cxx[@]}" -framework AppKit -framework CoreGraphics "$src/preflight.mm" -o "$out/fixture-preflight"
"$out/fixture-preflight" --self-test
"${cxx[@]}" -framework AppKit "$src/delivery_fixture.mm" -o "$out/observation-fixture"
app="$out/ZodyObservationFixture.app"
mkdir -p "$app/Contents/MacOS"
cp "$out/observation-fixture" "$app/Contents/MacOS/observation-fixture"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>org.zody.cua.observation-fixture</string>
  <key>CFBundleExecutable</key><string>observation-fixture</string>
  <key>CFBundleName</key><string>Zody Observation Fixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
</dict></plist>
PLIST
"${cxx[@]}" -framework Foundation -framework ApplicationServices -framework IOKit "$src/lock-monitor.mm" -o "$out/lock-monitor"
