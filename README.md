# LXFlow

Locally-hosted, real-time run-of-show / cue tracking for live production. One machine runs the server; everyone else just opens a web address in a browser — no install for them. State auto-saves to a JSON file. Pure JavaScript, no native modules, no database to manage.

## Easiest way to run (share this with coworkers)

For hosts without Node.js, use one of these standalone packages in `dist/`:

- **LXFlow Standalone (Windows x64).zip**
- **LXFlow Standalone (Mac Intel).zip**
- **LXFlow Standalone (Mac Apple Silicon).zip**

The Windows executable has been tested locally. Mac executable formats and architectures have been checked; runtime validation still needs a Mac.

Node-dependent launcher packages are also available:

- **LXFlow (Windows).zip**
- **LXFlow (Mac).zip**

Unzip on the **host** computer (whoever is running the show that day) and double-click:

- Windows → **Start LXFlow.bat**
- Mac → **Start LXFlow.command** (first time: right-click → Open to get past Gatekeeper)

A window opens and the browser launches automatically. That window prints a
`http://<your-ip>:7390` address — share it with coworkers on the same Wi-Fi/LAN
and they connect in any browser, installing nothing. Keep the window open during
the show; closing it stops the server.

> One-time note: the host machine needs Node.js (a free ~30-second install). If
> it's missing, the launcher opens the download page for you. Coworkers who only
> connect by browser never need it.

## Run from source (developers)

```bash
npm install
node server.js                 # http://localhost:7390, opens your browser
node server.js --port=9001     # custom port
node server.js --code=showtime # require a room code to join
node server.js --no-open       # don't auto-open the browser
```

## Build a true single-file executable (optional, no Node needed at all)

The launcher above needs Node on the host. If you'd rather hand coworkers a
single `.exe` / Mac binary with nothing to install, run this once on a computer
with normal internet access:

```bash
npm install
npm run dist
```

This bundles the app, builds pinned Node 22 standalone executables via
`@yao-pkg/pkg`, and creates clean ZIPs with checksums in `dist/`. Run
`npm run test:packaging` to smoke-test the Windows executable and check Mac
architecture headers. See [PACKAGING.md](PACKAGING.md) for upgrade and signing notes.

## Features

- **Sign in** by name + position with a personal color.
- **Nested structure:** Event → Days → Shows → Cues — multi-day events, multiple shows per day.
- **Real-time sync:** every edit and cue move broadcasts instantly; markers show who's parked on which cue.
- **GO / cue tracking:** Space advances your pointer; cue IDs keep it on the same cue when rows are reordered. Deleting the active cue clears it instead of silently selecting another cue.
- **Undo / Redo:** shared, persistent history for edits, imports, notes, deletions, and show-data wipes. The latest team change is undone, not just your own changes.
- **Auto-track:** pin your view to another operator's cue as they progress.
- **Show Notes:** a per-event notes/communication feed — anyone can post timestamped notes the whole team sees live (the Notes button shows a count).
- **Per-cell edit locking:** focusing a cell claims it; others see it locked in your color until you move off.
- **Edit the grid:** drag the row number to reorder, ＋ insert, ✕ delete; `N` adds, `Delete` removes (rebindable).
- **Document import:** `.pdf`, `.docx`, `.xlsx/.xls`, `.csv/.tsv`, `.txt/.md`. Storyboard PDFs: embedded screen images are extracted full-resolution and attached to their cue; filename captions are preserved. Spreadsheet dates and times use the workbook's displayed text, duplicate headers receive unique internal keys, and the import dialog can start at a selected physical row with optional headers to skip metadata/personnel rows. Tables/sheets import directly; plain lines like `A2 - Mic talent` split into Who + Action; and memo-style run-of-show docs (day headers with `Who:` / `Time:` / `Where:` fields) are parsed into one table **per day** with those fields in their own columns. A column-mapping step lets you route any imported column to any show column before merging.
- **Adjustable UI:** add/remove/rename columns; 8 palettes (dark, light, greyscale, high-contrast, vaporwave, RGB, CMY, amber).
- **Show Mode:** a header toggle that locks all editing and keeps the live cue centered, auto-scrolling as it advances — works with Auto-track so a follower's screen rides along with the caller.
- **Multi-row copy / paste / duplicate:** select rows with the checkboxes, then Copy, Duplicate, or Paste them into any show, day, or event (missing columns are created on paste).
- **Visual cue notifications:** give any cue a pop-up message aimed at "All" or a specific position, with an optional standby that fires a set number of cues earlier. Visual only — no sound, by design for production.
- **Mobile layout:** a slider toggle in the header switches to a touch-friendly card view (auto-on for small screens).
- **Show Notes sidebar:** recent notes are always visible in the right sidebar in addition to the full Notes panel.
- **Settings page:** one panel for Appearance (palettes + custom per-element colors), keyboard shortcuts, a **Network adapter** picker (host-only; bind the app to one adapter, e.g. Wi-Fi, to keep it off a show/Ethernet network), and a guarded **Wipe all show data** (type-to-confirm).
- **Cue images:** attach images to any cue (the ⎙ button on a row, or via storyboard import); thumbnails show under the cue, click to enlarge. Images are stored full-resolution and served over HTTP, not embedded in the realtime sync.
- **Renumber cues:** a sub-bar button rewrites the Cue # column 1..N for the current show (Cue # otherwise auto-fills by position and stays editable).
- **Custom keybinds:** click a key, press a new one.

## Configuration

| Flag | Env | Default | Meaning |
|------|-----|---------|---------|
| `--port=N` | `ROS_PORT` | 7390 | Port to serve on |
| `--code=X` | `ROS_CODE` | (none) | Require a shared room code to join |
| `--host=IP` | `ROS_HOST` | all | Bind to one adapter's IP only (also settable in Settings → Network) |
| `--no-open` | `ROS_NO_OPEN=1` | off | Don't auto-open the browser |
| | `ROS_DATA` | `runofshow-data.json` next to the app | Data file location |

## Persistence

All cue data is saved to `runofshow-data.json` (next to `server.js`, or next to
the executable when packaged), written atomically on every change. Back it up by
copying that file and the `runofshow-images` folder. No database, no setup.

Undo/redo history is stored with the show data, bounded to 50 steps per direction
and 16 MB combined. A new edit clears redo. Images are retained after deleting cues
or wiping show data so recovery can restore them.

The server also keeps the previous valid save at `runofshow-data.json.bak`.
If the main file is unreadable, a valid backup is loaded and the damaged file is
preserved with a `.corrupt-<timestamp>` suffix. If neither file is valid, startup
stops rather than replacing your show with blank data.

## Spacebar and editing

Space advances cues when the main app has keyboard focus. While typing in a cell
or input, it remains a normal space. Press **Escape** to finish cell editing, then
press Space, or click **GO**. In Auto-track, cue movement is controlled by the
operator you follow. Dialogs and held-down repeated keypresses do not advance cues.
Missing saved shortcut settings fall back to the defaults; custom bindings remain
available in Settings.

## Project layout

```
runofshow/
  server.js          # HTTP + WebSocket + JSON store + doc parsing (dev source)
  public/index.html  # the entire web client
  build.mjs          # esbuild bundler (embeds the HTML)
  package.json
  dist/              # ready-to-share double-click packages (+ zips)
```

## Network & host controls

The **Network adapter** picker in Settings is restricted to the **host** — only the browser on the machine running the app (via `http://localhost:<port>`) can list or change which adapter the app binds to. Coworkers on the LAN can't see or alter it. When you bind to one adapter, a loopback listener keeps `localhost` working on the host so you never lose access to host controls.

## Notes & limits

- Cell locking prevents two people editing the *same* cell. Reorder/delete are last-write-wins.
- Cue pointers follow stable IDs. Deleting the active cue leaves no cue selected; GO then selects the first cue.
- Theme, keybinds, and column show/hide are per-device (browser localStorage). Cue data and column add/remove/rename are shared.

LXFlow retains the legacy `runofshow-*` data filenames and `ROS_*` environment variables so existing shows and settings remain compatible. The source folder is still named `runofshow`.

## Column colors — version 1.4.1

Open **Tools → Columns** and choose a color beside any column. Headers and cells get
a color accent and light tint in both table and Cards views. Use **No color** to reset.
Colors are shared across the event, saved with the show data, and support Undo/Redo.
Use matching colors for department columns such as Audio, Video, and Lighting, or any
other grouping. Colors apply to entire columns, not rules based on individual cell values.

## Tablet interface — included since version 1.3.0

The main toolbar keeps Cards, Undo/Redo, and Show Mode within reach. Open **Tools**
for Import Doc, Columns, Notes, Events, and Settings. **Cards** switches between the
table and a touch-friendly cue layout; your previous mobile preference is retained.
Show Mode hides editing controls and empty card fields, and GO stays prominent.
Controls have larger touch targets, visible keyboard focus, and responsive spacing.

## Import reliability — included since version 1.2.0

Use the new LXFlow packages and check the **1.4.1** badge. Older retained Run of Show
packages have an outdated spreadsheet parser that can expose Excel times as decimals.
Reimport the original workbook to replace previously affected imports.

The import dialog supports a physical starting row, a header/no-header checkbox,
all-row previews, and per-column value handling. Preserve displayed text is the default.
For source cells that actually contain unformatted Excel day fractions, explicitly choose
time (24h) for Start/End or duration for TRT. Review the preview before merging.
Duplicate destination mappings are rejected; merging multiple tables is one undoable edit.
Starting-row settings apply to all sheets, and Merge all appends into the current show.
PDF filenames are preserved; positional image matches still require review.

For completed work and remaining limits, see [the import review](IMPORT_REVIEW.md). Run
`node scripts/audit-imports.mjs` to reproduce the documented parser edge cases.

## Cue lights (ESP32)

Optional external cue lights: one ESP32 + 12-LED ring + button per position, about $21 each.
Parts, wiring, flashing and setup are in [firmware/README.md](firmware/README.md).

- Lights join the same Wi-Fi as the host and find LXFlow automatically (UDP 7391), or take
  the host IP in their setup page. They use the room code if one is set.
- **Settings → Cue lights** (host computer only): pick the **caller** whose live cue drives
  the lights, the **standby style** (flash → ack → steady, or steady), and give each light
  a name and position (`all` = every notification). **Identify** spins a light white.
- Lights follow each cue's 🔔 notification exactly like the pop-ups: **Send to** picks the
  position, **Standby lead** sets how many cues ahead standby starts (0 = GO only).
  Red = standby, green = GO (off after 3 s), blue breathing = lost link (cue cleared).
- Ack: the light's button, or the flashing **STANDBY — ACK** button on the screen of any
  operator a standby is sent to. It stops the light at their position flashing.
- **Ack dots:** each person in the sidebar's *On this page* list has a dot: green when
  acknowledged or nothing is pending, red while their standby is unacknowledged, and dim
  flashing red for 10 s if the caller GOes before they ack. **Hide sidebar** in the header
  hides the whole sidebar on that device. Settings → Cue lights → *With steady standby*
  chooses whether steady style still needs an ack.
- Settings persist in `runofshow-config.json` (`ROS_CONFIG` overrides the path).

