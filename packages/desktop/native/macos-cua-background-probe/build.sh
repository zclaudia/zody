#!/bin/bash
# Build an independent signed experiment bundle. The product Helper is a different identity.
set -euo pipefail
src_dir="$(cd "$(dirname "$0")" && pwd)"
probe_root="$HOME/Library/Application Support/Zody AX Probe"
mkdir -p "$probe_root"
probe_stage="$(mktemp -d "$probe_root/build.XXXXXXXX")"
trap 'rm -rf "$probe_stage"' EXIT
bundle="$probe_stage/Zody AX Probe.app"
contents="$bundle/Contents"
mkdir -p "$contents/MacOS" "$contents/Resources"
cxx=(xcrun clang++ -std=c++17 -fobjc-arc -Wall -Wextra -O1)
"${cxx[@]}" -framework Foundation "$src_dir/verdict.mm" "$src_dir/verdict_test.mm" -o "$probe_stage/verdict-test"
"$probe_stage/verdict-test"
"${cxx[@]}" -framework AppKit "$src_dir/target.mm" -o "$contents/MacOS/probe-target"
"${cxx[@]}" -framework AppKit -framework ApplicationServices "$src_dir/controller.mm" "$src_dir/ax_driver.mm" "$src_dir/verdict.mm" -o "$contents/MacOS/probe"
cp "$src_dir"/electron-*.cjs "$contents/Resources/"
electron_exe="$(cd "$src_dir/../.." && node -p "require('electron')")"
test -x "$electron_exe"
echo "$electron_exe" > "$contents/Resources/electron-path.txt"
cat > "$contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.zclaudia.zody.ax-concurrency-probe</string>
<key>CFBundleName</key><string>Zody AX Probe</string>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
identity='Zody Local Computer Use'
codesign --force --options runtime --sign "$identity" -i io.github.zclaudia.zody.ax-concurrency-fixture "$contents/MacOS/probe-target"
codesign --force --options runtime --sign "$identity" "$bundle"
codesign --verify --deep --strict "$bundle"
installed="$probe_root/Zody AX Probe.app"
if [[ -e "$installed" ]]; then
  mv "$installed" "$probe_stage/previous.app"
fi
if ! mv "$bundle" "$installed"; then
  if [[ -e "$probe_stage/previous.app" ]]; then mv "$probe_stage/previous.app" "$installed"; fi
  exit 1
fi
echo "$installed"
