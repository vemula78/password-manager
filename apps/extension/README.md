# @pw/extension — Password Vault browser extension (V1)

Companion browser extension (Manifest V3) for the zero-knowledge Password Vault. Targets
Chrome, Edge (both Chromium MV3) and Firefox (MV3-capable since Firefox 115+).

## Architecture

- **Own encrypted vault copy.** The extension does not talk to the web/mobile app live. On
  first run you import a `.pwmbackup` file (the same encrypted backup exported from
  Backup & Restore in the web/mobile app) via `restoreBackup` + `VaultStore.open` from
  `@pw/core`. Re-importing later replaces the copy. **There is no live sync** — that is V2
  scope (see PLAN.md).
- **Storage.** The imported vault is stored in `chrome.storage.local` as ciphertext only — the
  exact same encrypted blob format `@pw/core`'s `VaultStore` produces. Keys and plaintext
  vault data are never written to any persistent storage.
- **Unlock state lives in the background service worker, not the popup.** The popup is a thin
  client: it sends a runtime message to unlock, and from then on every action (list items,
  reveal a field, fill a page) is a message round-trip to the background worker, which holds
  the unlocked `VaultStore` in memory. This was a deliberate choice over caching key material
  in `chrome.storage.session`, because `@pw/core`'s `VaultStore` doesn't expose an API to
  export the raw vault key — only the whole opened store. See `src/background/index.ts`.
- **Idle lock.** `chrome.alarms` schedules a lock at `autoLockMinutes` after each unlocked
  action; firing the alarm wipes the in-memory store. "Lock now" in the popup does the same
  immediately.
- **MV3 service worker kills.** Chrome/Edge can terminate an idle service worker at any time.
  When that happens, `store` is gone and the very next popup open (or any message) finds it
  `null` — the popup then asks for the master password again. This is **treated as an
  automatic lock**, not a bug; there is nothing to migrate or recover, because nothing
  sensitive was ever written to disk.

## Permissions

`activeTab`, `scripting`, `storage`, `alarms`, `clipboardWrite`, and (Chrome/Edge only)
`offscreen`. No `host_permissions` — the "Fill" action only ever touches the tab that was
active when the user invoked the extension (activeTab), and the content script is injected
on demand via `chrome.scripting.executeScript` rather than being declared to run
automatically on every page.

## Security rules enforced in code (not just UI)

- **Domain match / lookalike / phishing warning** (`src/lib/domain.ts`): before any fill, the
  active tab's host is compared against the item's stored URL host. Matching is deliberately
  ASYMMETRIC: an exact match, or the active host being a *subdomain* of the stored host,
  proceeds silently; the parent direction does NOT (an item saved for `login.example.com`
  never silently fills on `example.com`, and `mysite.github.io` never silently fills on
  `github.io` — no public-suffix list is bundled, so parent-direction fills go through the
  explicit confirmation path). Anything else — including confusable-character typosquats like
  `paypa1.com` vs `paypal.com` — requires an explicit "Fill anyway" confirmation.
- **TOCTOU guard on fill**: the background never trusts the popup's snapshot of the tab or
  URL. At fill time it re-queries the active tab of the current window, requires it to be the
  same tab the popup targeted, re-reads its URL *at that moment*, and aborts if the host no
  longer equals the host the popup displayed (and any confirmation was given for). The full
  check re-runs after every confirmation round-trip, so a tab that navigates to a phishing
  page between warning and "Fill anyway" is caught.
- **HTTP warning**: filling on a plain `http://` page also requires confirmation.
- **Sender validation**: the background rejects any runtime message that does not come from
  this extension's own pages, and vault-touching requests (unlock, import, list, get, reveal,
  save, settings, fill) additionally must come from the popup page itself. Content scripts
  have no message surface at all — the content script only ever *replies* to a
  `tabs.sendMessage` from the background.
- **Never auto-fill sensitive banking fields**: transaction passwords, MPIN, TPIN, and CVV are
  never candidates for the "Fill" action (`src/lib/sensitiveFields.ts`, built directly off
  `@pw/core`'s field templates so it can't silently drift out of sync). They are copy/reveal
  only, gated by master-password reauthentication (`REVEAL_FIELD` calls `@pw/core`'s
  `verifyMasterPassword`) — the same rule the web app enforces for sensitive fields.
  (There is currently no raw UPI PIN field in the shared templates — only a hint field — so
  there is nothing to refuse there beyond that.)
- **Per-fill confirmation for banking/government items**: even an ordinary login fill on a
  `netbanking`, `demat`, or `govid` item shows the target domain and requires explicit
  confirmation before proceeding.
- **No hidden-field fill**: the injected fill script (`src/lib/fillLogic.ts`) only fills
  visible fields. The visibility predicate rejects `type=hidden`, `display:none`,
  `visibility:hidden`, `opacity:0`, `aria-hidden` on the element or any ancestor, elements
  with no layout boxes, boxes smaller than 10×10 px, and boxes positioned far outside the
  document/viewport — the usual honeypot-hiding tricks. When the password field sits inside a
  `<form>`, the username is filled within that SAME form only (a decoy form elsewhere on the
  page cannot soak up half the credentials).
- **Top frame only**: fills use `allFrames: false` at the injection call site, and the fill
  script itself refuses to run if `window.top !== window` as a second, independent check.
- **No decrypted sensitive values reach the popup at rest.** `GET_ITEM` redacts every
  template-`sensitive` field's value before it leaves the background worker; only
  `REVEAL_FIELD` (after reauth) returns an actual value, and only for that one field.
- **Restoring a backup counts as an unlock.** Both `IMPORT_BACKUP` and `UNLOCK` share the same
  exponential-backoff failed-attempt counter (`src/lib/backoff.ts` — same formula as the web
  app's unlock screen: 30s/60s/120s/… after 5 fails, capped at 1 hour).

## Clipboard auto-clear

The popup writes to the clipboard itself (`navigator.clipboard.writeText`, needs the user
gesture the popup already has) and asks the background worker to schedule a clear via
`chrome.alarms`.

- **Chrome/Edge**: the background worker keeps a hidden `chrome.offscreen` document alive
  (`src/background/offscreen.ts`) purely so it can clear the clipboard even after the popup
  has closed — offscreen documents are a real page context and can call the Clipboard API
  outside of a popup's lifetime.
- **Firefox**: there is no `chrome.offscreen` equivalent. The popup also sets its own
  `setTimeout` to clear the clipboard if it is *still open* when the timer elapses, but if the
  user closes the popup before that, **the clipboard is only cleared the next time the popup
  is opened** (not after a fixed number of seconds in the background). This is a known,
  documented limitation for Firefox in this V1 — not silently swallowed. Because of it, the
  popup shows an explicit warning (with a "Copy anyway" confirmation) before copying any
  *sensitive* field value on browsers without background clipboard clearing, telling the user
  the clipboard cannot be auto-cleared until the popup reopens.

## Manifest differences (Chrome/Edge vs Firefox)

Two manifests are checked in, `manifest.chrome.json` and `manifest.firefox.json`; the build
picks the right one per target:

| | Chrome / Edge | Firefox |
|---|---|---|
| Background | `background.service_worker` | `background.scripts: ["background.js"]` (classic background page/event page, no MV3 service worker support yet) |
| `offscreen` permission | present (clipboard-clear support) | omitted (`chrome.offscreen` doesn't exist; code feature-detects and falls back gracefully) |
| `browser_specific_settings.gecko` | n/a | required for a Firefox add-on ID + minimum version |

Both targets build the same `background.js`/`content.js`/`popup.html` bundles — only the
manifest differs.

## Building

```
npm install                 # from the repo root, once
npm run build --workspace @pw/extension        # builds BOTH dist/chrome and dist/firefox
npm run build:chrome --workspace @pw/extension  # chrome/edge only
npm run build:firefox --workspace @pw/extension # firefox only
```

This produces a fully loadable, self-contained directory per target:

```
dist/chrome/   manifest.json  popup.html  background.js  content.js  offscreen.html  assets/  icons/
dist/firefox/  manifest.json  popup.html  background.js  content.js  offscreen.html  assets/  icons/
```

`popup.html`/`offscreen.html` are built as ordinary Vite ES-module bundles; `background.js`
and `content.js` are built separately as IIFE bundles (`scripts/build.mjs`) so they work as
classic scripts everywhere (Chrome's MV3 service worker doesn't require `"type": "module"`,
and Firefox's background page does not support it the same way).

The included `icons/*.png` are solid-color placeholders (generated, not designed) — swap them
for real artwork before shipping.

### Type checking & tests

```
npm run typecheck --workspace @pw/extension   # tsc --noEmit
npm run test --workspace @pw/extension        # vitest — pure-logic unit tests
```

## Loading the built extension

### Chrome / Edge (unpacked)

1. Run `npm run build:chrome --workspace @pw/extension`.
2. Go to `chrome://extensions` (or `edge://extensions`).
3. Turn on "Developer mode" (top right).
4. Click "Load unpacked" and select `apps/extension/dist/chrome`.
5. Pin the extension and click its icon to open the popup.

### Firefox (temporary add-on)

1. Run `npm run build:firefox --workspace @pw/extension`.
2. Go to `about:debugging#/runtime/this-firefox`.
3. Click "Load Temporary Add-on…" and select any file inside `apps/extension/dist/firefox`
   (e.g. `manifest.json`).
4. Note: a *temporary* add-on is removed when Firefox restarts — reload it each session, or
   package it with `web-ext build` / sign it for permanent installation.

## Import-backup workflow

1. In the web or mobile app, go to Backup & Restore and create a local encrypted backup
   (`.pwmbackup` file).
2. Open the extension popup — the first-run screen asks for that file.
3. Choose the file, choose whether you're unlocking with the master password or the recovery
   key, enter it, and import.
4. The extension now holds its own encrypted copy in `chrome.storage.local` and unlocks with
   the same master password from then on.
5. To bring the extension's copy up to date after adding/changing items elsewhere, export a
   fresh `.pwmbackup` and use "Import a different backup instead" from the locked screen (or
   from first-run) — this **replaces** the existing copy.

## Known / documented limitations (V1)

- **No live sync.** The extension's vault copy only updates when you re-import a fresh
  `.pwmbackup`. This is intentional V1 scope (SPEC "Recommended First Release" — full browser
  autofill and multi-device sync are V2).
- **MV3 service-worker kills lock you out with no warning.** Acceptable per spec ("Lock
  extension after inactivity") — nothing sensitive is lost, you just re-enter the master
  password.
- **Clipboard auto-clear on Firefox** only guarantees a clear on next popup open if the popup
  was already closed when the timer elapsed (see "Clipboard auto-clear" above). The popup
  therefore warns — and requires a "Copy anyway" confirmation — before copying a sensitive
  field value on browsers without background clipboard clearing.
- **"Save login for this site"** does not scrape the page's actual form; it prefills the
  title/URL from the active tab and expects the user to type or generate the credential. Full
  form-capture autofill is V2 ("Full browser autofill").
- **Placeholder icons.** `public/icons/*.png` are generated solid-color squares, not real
  artwork.

## Verification performed

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run` — 39 tests passing, covering: domain/host matching and lookalike
  detection, the exponential unlock-backoff formula, the fill-refusal policy for sensitive
  banking fields, and the DOM fill logic (visible-field selection, hidden/honeypot field
  refusal, disabled/readonly field skipping) under jsdom.
- `npm run build` — produces a complete, loadable `dist/chrome` and `dist/firefox` directory
  for each target (manifest + background.js + content.js + popup.html + offscreen.html +
  icons), verified file-by-file after the build.
- **Runtime-verified (static-serve, chrome.* shim):** the popup was served standalone (its
  actual built bundle, not a dev rebuild) with a minimal `chrome.runtime`/`chrome.tabs` mock
  and exercised in a real browser: first-run screen, unlocked item list filtered/labelled by
  active-tab domain, item detail expand/collapse, sensitive-field reveal gated by a
  master-password reauth modal, the password generator (this caught and fixed a real bug —
  the popup wasn't calling `initCrypto()` before using `@pw/core`'s generator/strength
  functions, which would have thrown in the real extension too), the settings panel, and the
  "save login" form.
- **Not runtime-verified:** loading the actual unpacked extension into a real Chrome/Edge/
  Firefox instance (no local browser with unpacked-extension loading was reachable from this
  environment — the only connected browser was a non-local Windows instance that can't be
  pointed at a local unpacked directory). This means the following are NOT confirmed against
  a real browser and should be checked by hand before relying on them: the MV3 background
  service worker actually starting and holding the `VaultStore`; `chrome.scripting
  .executeScript` + `chrome.tabs.sendMessage` actually injecting and filling a real page's
  form; the `chrome.offscreen` clipboard-clear path; `chrome.alarms`-driven idle lock firing;
  and the Firefox manifest loading without error in Firefox specifically.
