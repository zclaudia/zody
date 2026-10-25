# Android notification render Service authorization

## Product and security rule

`MobileNotificationRenderService` is an external IPC entry point because the separately installed `ntfy-bridge` must start it after receiving an authorized notification. Keep the Service exported for that integration, but require `android.permission.DUMP` at the Android component boundary. Do not rely on the Service payload parser as caller authentication.

The existing daemon contract remains unchanged: `ntfy-bridge` runs `am start-foreground-service` as shell UID 2000 when its `su 2000 -c` path works, and may fall back to root UID 0. Android assigns `DUMP` to shell, while the framework permits root to access exported components regardless of declared component permission. Ordinary app UIDs must be denied before Android delivers the Intent. The permission requirement applies to both debug and release variants.

The Activity, FileProvider, ntfy subscription format, notification envelope, and notification routing behavior are unchanged.

## Ownership and event order

```text
ntfy-bridge (shell UID 2000 or root UID 0)
  → explicit start-foreground-service
  → Android checks the Service's DUMP permission
  → authorized caller: deliver Intent to MobileNotificationRenderService
  → validate version, opaque IDs, and expiry
  → publish generic notification

ordinary app UID
  → explicit start-foreground-service
  → Android denies the component permission
  → Intent is not delivered; no notification is created
```

Android's service manifest contract says a caller without the declared permission cannot start, bind, or stop the Service and its Intent is not delivered. The AOSP Android 14 shell package requests `DUMP`, platform permission configuration assigns it to shell UID, and the component permission check grants root UID access.

## Acceptance scenarios

- The debug and release merged manifests retain `exported=true` and `permission="android.permission.DUMP"` for `MobileNotificationRenderService`.
- A regular app UID attempting to start the exported Service is denied before `onStartCommand`; it cannot create a notification by forging an envelope.
- The ntfy-bridge shell-UID delivery path and root fallback remain authorized and continue to deliver a real notification.
- Build configuration verification fails if the Service becomes unprotected, non-exported, or uses a different permission, so changes cannot silently invalidate either the security boundary or the integration.

## Validation boundary

The build check validates the source manifest contract; merged Manifest inspection confirms the packaged debug and release variants. Device evidence must separately exercise a normal app caller (negative) and the installed ntfy-bridge delivery path (positive). Root/Shizuku behavior is not inferred from a fixture: the device run must confirm the selected backend's actual caller UID and successful notification delivery.
