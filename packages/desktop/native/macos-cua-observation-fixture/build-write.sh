#!/bin/bash
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)"
if [[ $# != 1 || "$1" != /* || ! -d "$1" ]]; then
  echo 'expected existing absolute build directory' >&2; exit 2
fi
out="$1"
cxx=(xcrun clang++ -std=c++17 -fobjc-arc -Wall -Wextra -Werror -Wno-unused-function -O1)
"${cxx[@]}" -DWRITE_FIXTURE_TEST -framework AppKit "$src/write_fixture.mm" "$src/write_barrier.mm" "$src/explicit_manifest.mm" -o "$out/write-model-test"
"${cxx[@]}" -framework Foundation "$src/write_barrier_test.mm" "$src/write_barrier.mm" -o "$out/write-barrier-test"
"$out/write-barrier-test" "$out"
"$out/write-model-test" "$out"
"${cxx[@]}" -framework AppKit "$src/write_fixture.mm" "$src/write_barrier.mm" "$src/explicit_manifest.mm" -o "$out/write-fixture"
app="$out/ZodyControlledWriteFixture.app"
mkdir -p "$app/Contents/MacOS"
cp "$out/write-fixture" "$app/Contents/MacOS/write-fixture"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.zody.cua.controlled-write-fixture</string>
<key>CFBundleExecutable</key><string>write-fixture</string>
<key>CFBundleName</key><string>Zody Controlled Write Fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>
PLIST
