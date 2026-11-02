#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SDK=${SDK:-/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk}
APP="$ROOT/Zody CUA Preflight Probe.app"
BIN="$APP/Contents/MacOS/ZodyCuaPreflightProbe"

mkdir -p "$APP/Contents/MacOS"
cp "$ROOT/Info.plist" "$APP/Contents/Info.plist"

/usr/bin/clang++ \
  -std=c++17 \
  -x objective-c++ \
  -fobjc-arc \
  -arch arm64 \
  -isysroot "$SDK" \
  -mmacosx-version-min=14.2 \
  -O2 \
  -Wall \
  -Wextra \
  -Werror \
  "$ROOT/main.mm" \
  -framework AppKit \
  -framework CoreGraphics \
  -o "$BIN"

chmod 0755 "$BIN"
plutil -lint "$APP/Contents/Info.plist" >/dev/null
file "$BIN"
