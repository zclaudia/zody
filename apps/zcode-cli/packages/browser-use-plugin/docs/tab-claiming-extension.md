# Claiming an existing Chrome tab (extension backend)

The extension backend controls the user's current Chrome profile. Pairing a profile does not
authorize every logged-in page.

- `browser.user.openTabs()` only returns the tab title and a URL with userinfo, query, and hash
  removed. Use the returned object (or its `id`) exactly as provided.
- `browser.user.claimTab(info)` is a two-phase operation:
  1. The first call returns an `authorization_required` error immediately. It does **not** attach
     and does not wait for the user. Tell the user to open the Zody Browser Bridge extension and
     click **Allow** for that tab. Do not poll and do not repeatedly call `claimTab`.
  2. After the user confirms, call `claimTab(info)` **once more** from the same session. Only this
     second call attaches the tab.
- `authorization_required` has `sideEffect: "none"`. A pending authorization expires after about
  two minutes; a late or stale Allow cannot attach anything.
- `permission_denied` means the user denied the tab, closed the Popup without allowing it,
  another session/tab already has a pending request, or the authorization expired. After a
  denial, the next `claimTab` for the same session and tab returns `permission_denied` again; it
  does **not** re-open the authorization prompt. `target_unavailable` means the tab is closed,
  restricted (`chrome://`, Chrome Web Store, extension pages), occupied by DevTools, or cannot be
  attached. Do **not** automatically retry either error. Report the state to the user and stop, or
  create a new tab if the task allows it.
- A claimed user tab keeps `tabClass = user`. Use locators
  (`getByRole`/`getByText`/`locator`, `click`/`fill`/`press`/`selectOption`/`check`),
  `domSnapshot`, and `evaluate` against it. Coordinate CUA, viewport resizing, `fullPage`/`clip`/
  `ref` screenshots, downloads, and file choosers are unsupported for this backend. Do not ask
  the user to resize Chrome to make coordinates match; use the snapshot and locators instead.
- JS dialogs are intercepted. If a dialog is still unhandled when a user-tab command budget
  expires, the host dismisses it with `accept: false` and revokes the tab if the page remains
  blocked. `getDialog()`/`handleDialog()` are available when the task needs an explicit decision;
  never assume a blocking dialog was accepted.
