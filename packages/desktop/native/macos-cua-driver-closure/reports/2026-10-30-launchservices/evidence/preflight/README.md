# Zody CUA Preflight Probe

This is a minimal, read-only LaunchServices/TCC attribution probe. It is not a
replacement for the production Helper and does not prove final Helper
equivalence.

## Behavior

- Bundle identifier: `io.github.zclaudia.zody.cua-helper`
- Calls `CGPreflightScreenCaptureAccess()` exactly once.
- Does not call `CGRequestScreenCaptureAccess` or ScreenCaptureKit.
- Writes `pid`, `ppid`, `bundleId`, `preflight`, and UTC to the fixed path:
  `output/cua-launchservices/preflight-probe/result.json`
- Shows one small status window; the controller closes it later.

## Build (unsigned)

```sh
cd /Users/zhvala/SourceCode/zody
sh output/cua-launchservices/preflight-probe/build.sh
```

The app path is:

`output/cua-launchservices/preflight-probe/Zody CUA Preflight Probe.app`

The build is arm64, macOS deployment target 14.2, built with SDK 27.0. It does
not run `codesign`.

## Controller signing

Sign with the existing Helper identity, hardened runtime, and the empty
entitlements in this directory. Do not add TCC-related entitlements.

```sh
codesign --force --options runtime \
  --entitlements output/cua-launchservices/preflight-probe/empty.entitlements \
  --sign "$CODE_SIGN_IDENTITY" \
  "output/cua-launchservices/preflight-probe/Zody CUA Preflight Probe.app"
```

The controller should launch the signed app through LaunchServices and inspect
`result.json` plus the OS TCC responsibility attribution. This probe uses the
Helper identifier but is a separate executable; TCC attribution from this probe
must not be claimed as final Helper acceptance.
