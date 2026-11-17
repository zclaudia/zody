#!/bin/bash
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)"
if [[ $# != 1 || "$1" != /* || ! -d "$1" ]]; then
  echo 'expected existing absolute build directory' >&2; exit 2
fi
out="$1"
xcrun clang++ -std=c++17 -fobjc-arc -Wall -Wextra -Werror -O2 \
  -framework Foundation "$src/read_monitor_input_test.mm" -o "$out/read-monitor-input-test"
"$out/read-monitor-input-test"
xcrun clang++ -std=c++17 -fobjc-arc -Wall -Wextra -Werror -Wno-unused-function -O2 \
  -framework AppKit -framework ApplicationServices -framework IOKit \
  "$src/read_monitor.mm" "$src/../macos-cua-desktop-session/src/observer_session_status.mm" \
  -o "$out/read-monitor"
app="$out/ZodyReadMonitor.app"
mkdir -p "$app/Contents/MacOS"
cp "$out/read-monitor" "$app/Contents/MacOS/read-monitor"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.zody.cua.read-monitor</string>
<key>CFBundleExecutable</key><string>read-monitor</string>
<key>CFBundleName</key><string>Zody R1 Read Monitor</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>
PLIST
codesign --force --sign - "$app"
codesign --verify --strict "$app"
