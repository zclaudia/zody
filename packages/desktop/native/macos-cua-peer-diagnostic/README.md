# macOS CUA Peer Identity Diagnostic (R10-N)

Status: diagnostic-only, default disabled, product adoption blocked.

This executable is a narrow native experiment for the R10-N peer identity evidence. It owns a
private AF_UNIX listener and accepts only its own test client. It reads the complete peer
`audit_token_t` with `getsockopt(LOCAL_PEERTOKEN)` and asks Security.framework for the dynamic code
object with `SecCodeCopyGuestWithAttributes` and `kSecGuestAttributeAudit`. It never falls back to a
caller-supplied PID, peer JSON, first-message key, Team ID or environment value.

## What it checks

- the full kernel audit token: PID, effective UID, audit UID, real UID/GID, audit session ID and
  pidversion (pidversion must be positive);
- `SecCodeCheckValidity` for the dynamic code object and for an explicit narrow requirement;
- signing identifier, ad-hoc flag, leaf certificate presence and leaf DER SHA-256/SHA-1;
- an exact narrow designated-requirement policy of the form
  `identifier "<bundleId>" and certificate leaf = H"<40-hex SHA-1>"`;
- the actual static executable SHA-256, entitlements, architecture and minimum macOS version.

The Helper policy path always requires `profile: "local-self-signed"`. A separate calibration-only
path may pin the signed Node executable as a lower-layer Security.framework control. That calibration
does not relax the Helper policy, does not trust a Team ID, and is not Helper acceptance. It also does
not attest the JavaScript loaded by Node.

## Modes

```text
serve --workdir <owned-0700-dir> (--profile <local-profile.json> | --calibration-profile <node-profile.json>)
      --expect-pid <pid> --expect-uid <uid> [--timeout-ms <ms>]
connect --socket <path> [--timeout-ms <ms>]
connect-replace --socket <path> [--hold-ms <ms>] [--timeout-ms <ms>]
connect-partial --socket <path> --declared-bytes <n> --send-bytes <n> [--hold-ms <ms>]
hold-socket --socket <path> [--hold-ms <ms>]
pure-policy-check --pure-test-only --profile <local-profile.json> --facts <facts.json>
```

`pure-policy-check` is a pure-test-only policy probe. It cannot be reached from a peer frame or a
production input; it never sets a grant and always reports `helperAuthorization: "blocked"`.

## Build and run

```sh
node packages/desktop/scripts/build-macos-cua-peer-diagnostic.mjs
node packages/desktop/scripts/test-macos-cua-peer-diagnostic.mjs
```

The build fixes `xcrun --sdk macosx27.0`, arm64 and `-mmacosx-version-min=14.2`. It does not install,
download or update tools. It does not run `codesign`, create/import certificates, touch the keychain,
request TCC, take screenshots, use window APIs or inject input. The compiler/linker may emit an ad-hoc
signature; that artifact is a probe only and is never treated as signed Helper acceptance.

## Limitations

- A positive local-self-signed Helper identity, TCC authorization, machine-level lease, native input,
  final frame and product integration are not implemented or proven here.
- The native profile path validates the 12-field schema, file ownership/mode and identity policy. It
  does not cross-check `bundleShortVersion`, `bundleVersion` or `executableName` against an actual
  bundle and does not perform a full static doctor. Do not read a profile-shaped pass as that.
- The Node calibration verifies only the Node process signature mechanism; it does not attest loaded
  JavaScript and is not a Zody Helper.
- The diagnostic JSON is not consumed by the product runtime and is not a serializable capability.
- Socket paths, frames and deadlines are bounded; cleanup only removes the exact socket inode/device
  created by this process and never recursively deletes a directory.
- The inode/device/UID check before unlink is a best-effort owned-path cleanup. `lstat` followed by
  `unlink` is not an atomic primitive against an arbitrary same-UID active attacker; it only prevents
  removing pre-existing or obviously replaced paths.
