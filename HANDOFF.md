# LXFlow — Handoff & Project Notes

_Last updated: 2026-09-21 · Owner: Dom (dfournier@creativeday.com) · Creative Day_

A locally-hosted, real-time run-of-show / cue-tracking web app for live production.
One machine (the **host**) runs a single server; everyone else just opens a URL in a
browser — no install for them. Built to be handed to coworkers as a double-click app.

---

## 1. Where we're at (status)

**Working; LXFlow reliability update completed 2026-09-21.** The app is feature-complete for current needs and has been
exercised against real Creative Day documents (the MHA "run of show" memo and the
"2026 AV Storyboard" PDF). Everything below is implemented, tested, and living in this
folder. Ready-to-share packages are in `dist/`.

Delivery model: coworkers connect by browser (zero install). Only the host machine runs
the app. Use the Node-dependent launcher packages when Node.js is available, or the+standalone packages when the host should require no Node installation (see §7).

**Reliability update:** cue pointers now follow stable IDs; shared persistent Undo/Redo
and previous-good-file recovery are implemented; Spacebar handling is guarded around
editing, modals, modifiers, and repeated keypresses; and clean standalone packages are
available for Windows x64 and both Mac architectures. Windows passed runtime testing;
Mac runtime validation remains outstanding. Import characterization is documented in
`IMPORT_REVIEW.md` and `scripts/audit-imports.mjs`.

**Recently added (most recent first):**
- Host-only network adapter picker (Settings → Network) with a loopback listener.
- Storyboard PDF import: extracts embedded screen images, attaches them to the right cue.
- Filename stripping on PDF import; manual image attach per cue.
- Custom color theme + consolidated Settings page; "Wipe all show data" (guarded).
- Renumber-cues button; Cue # auto-fill by position.
- Show Mode, mobile layout toggle, multi-row copy/paste/duplicate, visual cue
  notifications (standby/GO), per-event Show Notes (+ sidebar).
- Core: real-time sync, per-cell edit locking, auto-track/follow, doc import
  (docx/xlsx/csv/txt/pdf) with per-day memo parsing + column mapping, room-code gate.

**Nothing is mid-refactor.** No known broken features. See §9 for limitations.

---

## 2. Run it

**Dev (from source):**
```
cd runofshow
npm install
node server.js                 # http://localhost:7390 (opens your browser)
node server.js --port=9001     # custom port
node server.js --code=showtime # require a room code to join
node server.js --host=192.168.1.50   # bind to one adapter only (see §8)
node server.js --no-open       # don't auto-open the browser
```

**Packaged launchers:** `dist/LXFlow (Windows).zip` / `dist/LXFlow (Mac).zip`. Unzip on
the host, then double-click
`Start LXFlow.bat` (Win) or `Start LXFlow.command` (Mac, first time:
right-click → Open). The launcher runs `app/server.cjs` with Node and opens the browser.

Config flags all have env equivalents: `ROS_PORT`, `ROS_CODE`, `ROS_HOST`, `ROS_DATA`,
`ROS_NO_OPEN=1`. A saved adapter choice lives in `runofshow-config.json` (see §8).

---

## 3. File / folder structure

```
runofshow/
  server.js            SOURCE server — HTTP + WebSocket + JSON store + doc/PDF/image parsing (~670 lines)
  public/index.html    SOURCE client — the entire single-page app (HTML+CSS+vanilla JS module, ~1050 lines)
  build.mjs            esbuild bundler: server.js + embedded index.html -> build/server.cjs
  build/server.cjs     BUILT single-file app (~5.5 MB, pure JS, no native modules). This is what ships.
  package.json         deps + scripts (start / bundle / dist)
  README.md            user-facing feature + usage docs
  HANDOFF.md           this file
  dist/                ready-to-share packages:
    LXFlow (Windows)/  Start LXFlow.bat + READ ME FIRST.txt + app/server.cjs
    LXFlow (Mac)/      Start LXFlow.command + READ ME FIRST.txt + app/server.cjs
    *.zip                   zipped versions of the two folders
  node_modules/        deps (formidable, mammoth, xlsx, ws, unpdf, pngjs; esbuild dev)
  index.html           STALE leftover from v1 (pre-public/). NOT used. Safe to delete.
```

**Editing model:** edit `server.js` and `public/index.html`, then `npm run bundle`
regenerates `build/server.cjs`. The packaged `app/server.cjs` files under `dist/` are
copies of `build/server.cjs` — re-copy them after a rebuild (or re-zip).

**Runtime data** (created next to whichever `server.cjs`/`server.js` runs):
- `runofshow-data.json`   — all events/days/shows/cues/notes (the show database)
- `runofshow-images/`     — cue images (PNG/original), one file per image
- `runofshow-config.json` — host-only settings (currently just the bound adapter)

---

## 4. Architecture

**Single Node process, pure JS (no native modules)** so it bundles into one file and can
be compiled to a standalone executable. Three concerns in `server.js`:

1. **HTTP** — serves the client, handles uploads, serves images.
2. **WebSocket (`ws`)** — real-time sync of state, presence, and locks.
3. **Persistence** — a plain JSON file, written atomically (temp file + rename),
   debounced ~40ms. No database. (Swapped off SQLite early on to kill a native dep and
   WAL-on-network-drive fragility.)

### Data model
`Event → Days → Shows → Cues`. Stored as `DATA.events = [{ ev, updated }]`; each `ev`:
```
{ id, name,
  columns: [{ key, label, width }],     // column defs (cue, time, who, action, dept, notes by default)
  notes:   [{ id, author, color, text, ts }],   // per-event Show Notes
  days:  [{ id, label, date, shows: [{ id, label, cues: [ {id, ...columnKeys, _images?, _notify?} ] }] }] }
```
A **cue** is column-flexible: `{ id }` plus arbitrary keys matching column `key`s, plus
optional meta: `_images` (array of image ids) and `_notify` ({text,target,lead}).
Cue images are referenced by **id only** — never embedded in the doc — so realtime
broadcasts stay small.

### Persistence functions
`loadEvents()` / `saveEvent(ev)` / `deleteEvent(id)` operate on `DATA`; `persist()`
debounces the atomic write. Images: `saveImageBuf(buf,ext)` → id; served from disk.

### HTTP routes
- `GET /` and `/index.html` → the client (served from memory; embedded in the bundle).
- `POST /upload` → parse a doc/sheet/PDF, returns `{ ok, filename, tables:[...] }`.
- `POST /attach` → store an uploaded image (original bytes), returns `{ ok, id }`.
- `GET /img/:id` → serve a stored image (cached), mime by extension.
- `GET /adapters` → list network interfaces. **HOST ONLY** (loopback requests; 403 otherwise).
- dev fallback: other paths try `./public`.

### WebSocket messages (client → server)
`join`, `pointer` (my cue position), `follow` (auto-track a user), `lock`/`unlock`
(per-cell edit lock), `event:update`/`event:create`/`event:delete`, `merge` (append
imported/pasted rows), `note:add`/`note:delete`, `data:wipe`, `net:setAdapter`
(**host only** — ignored unless the socket is loopback).
Server → client: `hello`, `state`, `presence`, `locks`, `joined`, `denied`,
`lockDenied`, `followAck`, `net:set`, `cuelights` (per socket, with `host` flag).
Cue lights: client → server `cuelight:ack` (acks lights at the sender's position) and
`cuelight:set` (**host only**; `op` = `caller` | `style` | `light` | `identify` | `forget`).
ESP32 lights use a separate socket path, `/cuelight` (see `cuelights.js`).

### Client (`public/index.html`)
Vanilla JS module, no framework. One `el()` DOM helper. Key pieces: `connect()` WS loop;
`renderAll/renderHead/renderBody`; per-device settings in `localStorage` (theme,
keybinds, hidden columns, show mode, mobile); `openSettings()` (Appearance + Keybinds +
Network + Danger zone); import modal with column-mapping (`buildMerge`); cue image
thumbnails render as an extra `tr.imgrow` under each cue (so scroll/advance index
`#body tr[data-idx]` to skip them).

---

## 5. Feature inventory (where to find each)

- **Real-time sync / presence / operator markers** — WS `state`/`presence`; `renderBody`.
- **GO / cue tracking + Auto-track** — `advance()`, `activeIdx()`, `applyFollow()`.
- **Per-cell edit locking** — `lock`/`unlock`, `applyLocks()`, `firedNotes` unrelated.
- **Show Mode** — `showMode`, `applyShowMode()`, `#app.showmode` CSS; auto-scrolls live cue.
- **Mobile layout** — `mobile` toggle, `body.mobile` CSS (table → cards via `data-label`).
- **Multi-row copy/paste/duplicate** — selection checkboxes; `copySel/dupSel/openPaste`.
- **Cue # auto-fill + Renumber** — `renderBody` (isCueNo) + `renumberCues()`.
- **Visual cue notifications (standby/GO)** — `editNotify()`, `checkNotifications()`, `#notifs`.
- **Show Notes** — per-event `notes[]`; `openNotes()` modal + sidebar `renderSideNotes()`.
- **Doc import** — server `parseUpload`: docx (`mammoth`), xlsx/csv (`xlsx`), txt, pdf.
  Spreadsheet imports preserve displayed date/time values, disambiguate duplicate
  headers, and accept a user-selected starting/header row so leading personnel or
  metadata rows can be skipped. See `IMPORT_REVIEW.md` for remaining hardening work.
  Memo-style docs split into one table **per day** (`parseMemoRunOfShow`); plain
  "ROLE - action" lines split into Who/Action; import modal maps columns.
- **PDF storyboard images** — `parsePdf` (see §6).
- **Custom theme / Settings / Wipe** — `openSettings()`; theme vars applied live.
- **Room code** — `--code`/`ROS_CODE`; `join` gate.
- **Network adapter picker** — Settings → Network (see §8).

---

## 6. PDF import + images (the tricky part)

`parsePdf(fp)` uses `unpdf` (pure-JS pdf.js) to read the PDF:
1. Reconstruct text lines from glyph Y-positions (pdf.js merges text; we re-split by line).
2. Strip filename tokens (`.jpg/.mp4/.pptx/...`) and bare "LEFT/CENTER/RIGHT SCREEN" labels.
3. Walk the operator list tracking the CTM to get each embedded image's page position.
4. Decode each image (`page.objs.get(name, cb)` — **async callback form**, see §10),
   convert RGBA (`imgToRGBA`, handles pdf.js kinds 1/2/3), encode **full-resolution
   lossless PNG** via `pngjs`, store on disk, get an id.
5. If the PDF has images → **storyboard mode**: time-prefixed lines become cue rows;
   each image attaches to the nearest cue *above* it by page Y. Otherwise → run the text
   through the normal memo/line parser.

Images are kept relatively unmodified (full-res PNG; manual attachments keep original
bytes). They're stored on the host and served over HTTP, never embedded in the sync.

Verified on "2026 AV Storyboard.pdf": 40 cue rows, ~23 with images attached.

---

## 7. Build & packaging

- `npm run bundle` → esbuild bundles `server.js` + embeds `public/index.html` (via a
  banner injecting `globalThis.__INDEX_HTML__`) into `build/server.cjs`. Then copy that
  into `dist/LXFlow (*)/app/server.cjs` and re-zip.
- `npm run dist` → bundles the app and produces clean standalone ZIPs for
  `node22-win-x64`, `node22-macos-x64`, and `node22-macos-arm64`, plus the two
  Node-dependent launcher ZIPs. `npm run test:packaging` verifies the Windows
  executable on loopback, PDF text/image behavior, and Mac executable headers.
  Mac runtime validation still requires a Mac; packages are unsigned/not notarized.

---

## 8. Network & host-only controls (important for live shows)

Dom runs this in live production. The **Ethernet port = the show network**; the app must
never be reachable there. Controls:

- **Bind to one adapter:** `--host=<ip>` / `ROS_HOST`, or Settings → Network (persists to
  `runofshow-config.json`, applies on next launch). Binding to the Wi-Fi IP keeps the app
  off the Ethernet/show network entirely.
- **Loopback listener:** when bound to a specific adapter, a second listener on
  `127.0.0.1` stays up so the host can always reach the app (and host controls) at
  `http://localhost:<port>` even though the main socket is Wi-Fi-only.
- **Host-only adapter controls:** `/adapters` and `net:setAdapter` require a **loopback**
  request. Coworkers on the LAN get 403 / a rejection and just see a "🔒 host only" note.
  Manage the adapter from the host at `localhost` (the launcher opens localhost).
- **Room code** (optional) gates who can join at all.

_Development now runs on the local Windows host. Bind verification servers explicitly to loopback._

---

## 9. Known limitations & next ideas

- Cell locking prevents two people editing the **same** cell; reorder/delete are
  last-write-wins. Cue pointers follow stable IDs through reorder and insertion;
  deleting the active cue clears it explicitly and GO then starts at the first cue.
- Notifications & Show-Mode scroll key off the **live** cue = the person you're following,
  else your own pointer. Non-followers only get their own cues.
- PDF text extraction needs a **text-based** PDF (no OCR for scanned/image-only pages).
- Storyboard image→cue matching is **positional** (nearest cue above); busy/odd layouts
  may need tuning. Re-import and eyeball.
- Adapter change **applies on next launch** (no live rebind — deliberately, to avoid
  disrupting a running show).
- Per-device settings (theme, keybinds, column show/hide, show mode, mobile) live in each
  browser's localStorage; cue data + column defs are shared.
- Possible next: OCR for scanned PDFs, auto-build Days from storyboard day headers,
  per-show column sets, and the import hardening described in `IMPORT_REVIEW.md`.

---

## 10. Dev gotchas (save yourself time)

- **esbuild + dynamic import:** import pdf.js `OPS` **statically** (`import { OPS } from
  'unpdf/pdfjs'`). A runtime `import('unpdf/pdfjs')` does NOT survive bundling and returns
  empty in the packaged exe (silently → 0 images).
- **pdf.js images are async:** fetch with the callback form `page.objs.get(name, cb)`
  (wrapped in `getPdfObj`), not the sync form, or images come back empty in the bundle.
- **Static button glyphs:** in HTML markup use the real character (⚙ ✕ …), NOT a JS
  `\uXXXX` escape — HTML renders the escape literally. (Bit us 3×.) JS-created buttons are fine.
- **Always rebuild after editing source:** `npm run bundle`, then re-copy `build/server.cjs`
  into the `dist/*/app/` folders and re-zip. Verify `md5sum` matches across all copies.
- **`dist/` housekeeping:** running the app from inside a `dist` folder writes
  `runofshow-data.json` / `runofshow-images/` there; the Windows package also picked up a
  nested `LXFlow (Windows)/LXFlow (Windows)/` folder from repeated packaging.
  A clean repackage (fresh `dist/` from the launcher templates + current bundle) resolves it.
- **Verify by byte/round-trip**, not by eye: this project was built with integration tests
  (WS round-trips, upload parsing, jsdom DOM checks) each step. Keep that habit.

## LXFlow rename (2026-09-21)

The product is now **LXFlow**. The existing workspace folder remains `runofshow`.
Runtime `runofshow-*` filenames, `ROS_*` environment variables, and browser storage
keys are retained for compatibility with existing shows and settings.
New LXFlow distribution packages contain only launchers, instructions, and the app;
legacy Run of Show packages are retained because they contain existing show data.

Original priorities from this handoff, now completed:
1. Stable cue-ID pointers so reorder/delete cannot silently shift the live cue.
2. Undo/recovery for destructive edits and accidental deletions.
3. Complete and validate standalone Windows/Mac executables for no-Node deployment.

## Progress note — spreadsheet import (2026-09-21)

The Schaeffler workbook at `C:\Users\CDT_LD\Downloads\Show_Flow_Schaeffler_CDT_2026_09.xlsx`
was inspected. Its main sheet uses formatted Excel time cells, including start/end times
and durations, and it includes a separate `UPDATES` sheet. The import source now reads
spreadsheet values with `raw: false`, preserving displayed values such as `6:30:00 AM`
instead of serial fractions or JavaScript Date values. Duplicate spreadsheet headers receive
unique internal keys, and the Import Document dialog accepts a 1-based starting/header row
so leading show-personnel or metadata rows can be skipped.

Reproduction and characterization live in `scripts/audit-imports.mjs`; the findings and
remaining import work are tracked in `IMPORT_REVIEW.md`. Source and tests are updated, and
all 10 existing regression tests passed at that point. Packaging was initially blocked.

### Completed follow-up — 2026-09-22

- Starting rows now use physical Excel row numbers, including blank rows. Changing
  the starting row automatically reparses the document; merging is disabled until the
  current preview is ready. The control appears only for spreadsheets and applies to
  every sheet; the chosen row supplies column headers, with data beginning below it.
- Spreadsheet headers cannot overwrite internal cue IDs. Duplicate labels retain
  separate values. Displayed times and durations, including durations over 24 hours,
  survive import without timezone conversion.
- Verified the Schaeffler main sheet: 101 imported rows, with the first timed cue
  displayed as 6:30:00 AM–7:30:00 AM and a 1:00:00 duration; UPDATES has 7 rows.
- All 11 regression tests pass. Windows executable upload checks pass for spreadsheet
  start-row/time handling and PDF text/image extraction. Client script syntax checked.
- Rebuilt all five ZIPs and checksums with the latest source. The packaging block is
  resolved. Mac architecture checks pass; actual Mac runtime validation remains open.

### Import hardening completed — LXFlow 1.2.0, 2026-09-22

This entry supersedes earlier import status and test counts. See IMPORT_REVIEW.md for
the complete current findings and remaining limitations.

- Preserve spreadsheet display strings end to end; CSV/TSV preserves literal text.
  Explicit per-column decimal-day clock/duration conversion handles unformatted source
  numbers without guessing. The header displays version 1.3.0 to distinguish old builds.
- Added headerless import, full mapped preview, source rows, warnings, collision-safe
  mapping, stable target selection, atomic multi-table merge, and server acknowledgement.
- Hardened Word structure/text retention, memo detection, PDF text/image retention,
  24-hour anchors, parser warnings, and upload temporary-file cleanup.
- All 26 tests pass. The supplied Schaeffler workbook passes the full upload/client/WS/
  disk/restart round trip. Browser preview and committed grid retain 6:30:00 AM,
  7:30:00 AM, and 1:00:00; Space advances to cue 1 of 101.
- Rebuilt all five release ZIPs and checksums. Windows standalone spreadsheet and PDF
  upload smoke checks pass; Mac architecture checks pass. Mac runtime remains untested.
- Legacy Run of Show archives contain the raw-value parser responsible for decimal
  times. They remain untouched because they contain user data. Use the new 1.3.0 build;
  previously damaged imports need reimport, not an automatic guess at their units.
- Remaining: complex PDF layout/OCR, staging extracted images until merge, per-sheet
  header settings, broader fixtures, and durable request deduplication after timeouts.

### Tablet UI pass — LXFlow 1.3.0, 2026-09-22

- Consolidated Import Doc, Columns, Notes, Events, and Settings into a native Tools
  disclosure. It closes after choosing an action, clicking outside, or pressing Escape.
- Larger 44px primary controls and row actions, 60px GO, rounded panels, clearer
  typography, keyboard focus outlines, and reduced-motion support. Existing palettes
  and saved device settings remain compatible.
- Mobile toggle is now labeled Cards. Tablet cards use two-column details; narrow
  screens stack fields. Show Mode hides editing controls and empty card fields while
  keeping cue advancement prominent. Scroll padding reserves space for GO.
- Browser reviewed at 1024x768 and 390x844: table/card switching, editing, cue
  highlighting, Show Mode, and Tools-to-import flow. All 26 regression tests passed.
- Rebuilt all five 1.3.0 release archives. Mac execution still requires Mac validation.
- Suggested product priorities (not implemented): pre-show checks for missing details,
  timing conflicts and disconnected operators; reusable show templates; import presets
  that remember recurring document mappings and time formats.

### Git repository setup

The repository now lives in the project root (`runofshow/`), with the existing initial
commit and `origin` remote preserved from the former nested `LXFlow/` repository.
Source, tests, packaging scripts, lockfile, and project documentation form the 1.3.0
baseline. `.gitignore` excludes dependencies, generated builds/releases, runtime show
data/images/configuration and recovery files. The unused root `index.html` is retained
locally and ignored; the active client is `public/index.html`.
The baseline is committed locally; pushing to GitHub is a separate action.

### Column colors — LXFlow 1.4.1, 2026-09-23

- Tools → Columns supports optional per-column colors and No color reset. Colors
  live in event.columns[].color, share through existing event updates, persist to disk,
  and participate in shared undo/redo. No data migration is needed.
- Headers get a colored edge and tint; cells get a subtle tint and side stripe in table
  and Cards views. Text keeps theme colors and active-cue highlighting remains visible.
- Column editor updates resolve the current event/column by ID/key to avoid losing
  subsequent edits after a server refresh. New column keys avoid collisions/reserved IDs.
- Browser verified multiple color edits, persistence across reload, reset, and Undo.
  Existing server-history regression now checks color persistence after restart/undo.
- This is whole-column styling; conditional colors based on cell contents remain future work.

### Column color contrast adjustment — 2026-09-23

Raised the translucent column tint from 9% (`18` alpha) to 22% (`38` alpha) so
department colors remain clear on dark and light surfaces while text and active-cue
highlighting stay readable. The change is in `public/index.html`; the 26-test suite
passes. It is ready to commit on `Column-Color-Code` once Git metadata permissions
are restored.

### Column surface stacking fix — LXFlow 1.4.1

Cards now render their base surface on a behind-layer pseudo-element. Column cells sit
above it with a stronger translucent fill, so each department color reads as its own
surface instead of looking like it is behind a tinted card. The table header and cells
use the same explicit cell-level backgrounds. The active-cue outline remains on top.

### Cue lights (ESP32) — 2026-10-22

- `cuelights.js` (new): light registry, caller-driven standby/GO, per-light ack, standby
  style, UDP discovery (`LXFLOW_DISCOVER` → `LXFLOW <port>` on 7391, only answered on the
  bound adapter's subnet). Targeting mirrors `notifyTargetsMe` (text required, `all`/
  `everyone`, contains-match on position; lead 0 = GO only). GO fires only when the
  caller's cue id changes, never on caller pick/reconnect or row inserts.
- `server.js`: `/cuelight` upgrade goes to its own `WebSocketServer` (not in `broadcast`);
  `cueLights.refresh()` after every presence broadcast; `cuelight:ack` / `cuelight:set`;
  `cuelights` added to `sendState`; discovery starts after listen; `ROS_CONFIG` and
  `ROS_DISCOVERY_PORT` env overrides (tests use them so they never touch the real config).
- `public/index.html`: Settings → Cue lights (host only), `#cueAck` screen ack button.
- `firmware/LXFlowCueLight`: Arduino sketch (WiFiManager, WebSockets, NeoPixel, ArduinoJson),
  esp32 core 3.3.x, partition `min_spiffs`. Builds clean; not yet run on hardware.
- Tests: `cuelights.test.mjs`, `server-cuelights.test.mjs`, `client-cuelights.test.mjs`
  (29/29 with the existing suite). Browser check against the bundle: settings, caller
  pick, position assign, screen ack, GO and 3 s clear all verified with simulated lights.

### Crew acks + hideable sidebar — 2026-10-26

- Standbys now apply to every operator on an LXFlow screen too, driven by the caller's
  pointer and the same targeting as the pop-ups (`userMatches` = `notifyTargetsMe`).
  `cuelights` state carries `crew: {userId: 'ok'|'pending'|'missed'}` and `ackSteady`.
- Ack paths: `cuelight:ack` → `ackUser` (own standbys + lights at their exact position);
  a light's button → `ackLight` (that light + operators at its exact position; `all`
  lights never ack people). A standby still unacked when the caller GOes onto it =
  `missed` for 10 s (`missMs`), then `ok`.
- `ackSteady` (default on; `cuelight:set` op `ackSteady`): whether steady style still
  needs an ack. Steady + no ack = always green, no ACK button.
- Client: ack dot per row in `renderPresence` (`.ackdot.ok/.pending/.missed`); the
  `#cueAck` button now shows when `crew[me.id] === 'pending'`; header **Hide sidebar**
  toggles `body.noside` (per device, `ros_sideHidden`).
- Firmware 1.0.1: the button acks in steady standby too (was flash only).
- Note: the on-screen pop-ups still follow each operator's own pointer, while lights and
  ack dots follow the caller.
- 31/31 tests; browser check of dots (pending → ack → green, missed → green after 10 s)
  and the sidebar toggle against the bundle.

### Cue light looks, conditions and commands — firmware 1.1.0 — 2026-10-27

- Firmware 1.1.0 is a renderer: `{t:'look', c:[r,g,b], p, r, b, cd?:{l,t}}`, patterns
  solid/flash/pulse/dblink/spin/strobe/countdown/dot/off. `{t:'local', lost, nowifi}` is
  saved in Preferences. The button always sends `ack`; the server decides what it answers.
  1.0.x lights still get the old `state` messages (standby, GO, off).
- `cuelights.js` conditions, highest first: stop, go, countdown, standby, call, hold,
  standbyAcked, missed, warning, places, nocaller, idle. Looks = DEFAULT_LOOKS < `looks`
  < `overrides[position]`; stealth caps the level. `all` lights take global and cue
  conditions but not position Hold/Call/hand countdowns. A light's ack answers its standby
  first, then a Call to its position.
- `_notify` gains `warn` (cues before the standby window) and `cd {mode:'time'|'seconds',
  seconds}`. Time mode reads the event's `time` column (or a column labelled Time/Start/
  Go time) as a clock time on the host. Seconds mode starts when the standby opens.
- Messages: `cuelight:call` (anyone), `cuelight:ackCall`, `cuelight:callCancel` (caller of
  the CALL, the show caller, or host), `cuelight:cmd` ops hold/places/stop/countdown/
  countdownCancel/stealth (show caller or host), `cuelight:set` ops look/override/
  stealthLevel/preview (host). Server → the CALL's sender: `cuelight:callAcked`.
- `cuelights` state adds `looks`, `overrides`, `stealth`, `stealthLevel`, `positions`,
  `cond {stop, places, holds, calls, countdowns}`, `crewCd`, `crewWarn`, `now`.
  STOP, Places and holds persist in the config; calls and countdowns don't.
- Client: sidebar *Cue lights* panel (`renderClPanel`), banners (`#clBanners`), Settings
  *Looks* editor with per-position overrides and Test, warning/countdown fields in the 🔔
  editor. 37/37 tests; browser check against the bundle with a simulated 1.1 light.
