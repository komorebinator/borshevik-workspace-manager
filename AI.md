# Borshevik Workspace Manager — AI Context & Task List

> **Memory buffer:** This file is the persistent project context for AI sessions working on this
> repo. Keep it up to date when making significant architectural changes or resolving bugs.

## Project Overview

GNOME Shell extension for the Borshevik Linux distribution. Replaces GNOME's default workspace
behaviour with an opinionated tiling + workspace management system.

**UUID:** `borshevik-workspace-manager@komorebinator`
**Shell versions:** 48, 49 (GNOME 48 / Mutter 17, Wayland only in practice)
**Language:** GJS (ES modules), CSS
**Install path:** `~/.local/share/gnome-shell/extensions/borshevik-workspace-manager@komorebinator/`

---

## Core Behaviour

### Window States
Each tracked window has one of: `floating` | `tiled-left` | `tiled-right` | `maximized`

### Tiling
- **Super+Left / Super+Right** — tile focused window to left/right half; press again to untile
- Drag a window to left/right edge → snap preview → release to tile
- Two tiled windows per workspace/monitor (`left` + `right` slots)
- Resize the split by dragging the inner edge of a tiled window; partner resizes in sync

### Auto-placement of new windows
- **Tall windows (hr > 0.9, wr 0.2–0.8):** auto-tiled into a free slot
- **Maximized/fullscreen windows with existing content:** moved to a new workspace automatically
- **Floating windows:** placed as-is; covered floaters relocated to previous workspace

### Workspace management
- **On maximize/fullscreen:** if other windows exist on the workspace → move the maximizing window
  to a new workspace to the RIGHT, activate it (user follows)
- **On unmaximize:** if on "our" workspace → return to previous workspace; if the window was
  previously tiled and there's a free slot there → re-tile it
- Empty workspaces created by the extension (`_ourWorkspaces`) are auto-navigated away from when
  they empty (`_leaveIfEmpty`)
- Workspace indicator in panel (replaces GNOME dots) — logo + numbered slots with app icons

### Panel Indicator
- Borshevik logo button (opens overview) at far left
- One pill per workspace with app icons; fully desaturated if inactive
- Last workspace always shown with `list-add-symbolic` icon (even if empty)
- Sticky/on-all-workspaces windows filtered out

---

## File Map

| File | Purpose |
|------|---------|
| `extension.js` | Everything — ~1650 lines, single class `BorshevikWorkspaceManager` |
| `stylesheet.css` | Panel indicator CSS only |
| `bwm_icon.svg` | Panel logo icon (4 white squares, 2×2 grid) |
| `schemas/` | GSettings schema: `debug-logging`, `move-window-when-maximized`, `float-sizes`, keybindings |
| `prefs.js` | Preferences UI |

---

## Key Data Structures

```
this._windows       Map<MetaWindow, WindowInfo>
this._layouts       Map<"wsIdx:monIdx", { left: MetaWindow|null, right: MetaWindow|null }>
this._suppress      Set<MetaWindow>   — suppress re-entrant notify::maximized-* during our ops
this._moving        Set<MetaWindow>   — windows being moved by us (skip workspace-changed auto-tile)
this._handled       Set<MetaWindow>   — windows that went through handleNewWindow/restoreInitialState
this._ourWorkspaces Set<number>       — workspace indices created by the extension (auto-cleanup eligible)
this._currentBatch  { wsIdx, wins[] } | null  — in-progress covered-floater batch relocation
this._drag          { win, monitor, startX, startY, tiledSide }  |  null
this._resize        { win, partner }  |  null

WindowInfo = {
  state:           'floating' | 'tiled-left' | 'tiled-right' | 'maximized'
  preMaxState:     string | null   — state before maximize (for restore)
  floatRect:       { x, y, width, height } | null
  layoutKey:       "wsIdx:monIdx"
  firstFrameFired: boolean
  pendingGeometry: { x, y, w, h } | null  — geometry queued before first-frame
  justMoved:       boolean | undefined    — user manually moved to ws, skip coverage check
}
```

---

## Non-obvious Implementation Details

### Chrome async geometry race
Chrome processes unmaximize asynchronously and restores its pre-maximize position AFTER we apply
tile geometry. Fixed via a one-shot `size-changed` signal handler that re-applies geometry once the
window settles. 2-second timeout as safety net.

### Chrome tab-detach window tracking
Tab-detach creates a window without firing `map` on Wayland. Fixed by late-registering in
`_onGrabBegin` when `op === Meta.GrabOp.MOVING` and window is untracked.

### floatRect ownership
The extension fully owns tiling geometry. Apps (including Nautilus) do NOT asynchronously restore
their own session geometry — we move_resize_frame them and that's final. At tile time, `_tileWindow`
always snapshots the full current frame rect (position + size) as `floatRect`. Map-time code also
sets `floatRect` from GSettings if available (for position init), but this is overridden at tile
time.

### First-frame / pending geometry
On Wayland, `move_resize_frame` sent before the window's first buffer commit is ignored. If
first-frame hasn't fired when we tile, geometry is stored in `pendingGeometry` and applied in the
first-frame signal callback.

### hadState path in _doTile
When tiling a maximized/fullscreen window, we call `_prepareAnimationInfo` (internal GNOME WM API)
before unmaximize to get proper animation, then apply geometry immediately after. The Chrome
size-changed handler is only attached in this path.

### Covered-floater relocation
Trigger: `notify::focus-window` → deferred callback (Z-order is only updated AFTER the signal,
so defer is mandatory). Checks all floating windows on current ws:monitor.

A floater is "fully covered" if:
- A fullscreen or maximized window is above it in Z-order, OR
- Both tile slots are occupied (together they fill the full screen), OR
- One tiled window above it and geometry contains the floater rect

When covered: move the floater to a **new workspace inserted to the LEFT of current** (currentIdx
becomes currentIdx+1). Multiple covered floaters in one check → all go to the same new workspace
(batch via `_currentBatch`). The user stays on the current workspace — relocation is silent.

The new workspace is added to `_ourWorkspaces` → `_leaveIfEmpty` will auto-navigate away when
it empties.

### _doTile called with state already 'tiled-*'
`_tileWindow` sets `info.state = 'tiled-${side}'` BEFORE calling `_doTile`. So inside `_doTile`,
`info.state === 'floating'` is always false when called from `_tileWindow`. The float-rect block
in `_doTile` only runs for _onUnmanaged fill-gap calls where state hasn't been changed yet.

### float-sizes GSettings
Float sizes stored as JSON string: `{ "WMClass": { wr: 0.55, hr: 0.55 }, ... }`. Used to seed
`floatRect` when a window is first ever tiled (no prior floatRect in memory). Saved at map-time.
On subsequent tiles, `_tileWindow` always snapshots the full current frame rect — GSettings is
not consulted again once `info.floatRect` is set.

---

## Known Working Well
- Basic tile left/right via keyboard and drag
- Split resize
- Maximized window auto-workspace
- Chrome geometry fix
- Chrome tab detach tracking
- Covered floater relocation
- Panel indicator with workspace numbers + icons

---

## Tasks

### Bugs

- [ ] **BUG-10: tile→maximize→unmaximize allows tiles on top of maximized window** *(regression from BUG-09 fix)*
  After setting `info.state = 'tiled-${side}'` early in `_onUnmaximized`, something allows
  tiling windows on the same workspace as a maximized window. Root cause unknown — needs logs.
  The early state change may confuse `_hasOtherWindows`, `_moveWhenMax`, or `handleNewWindow`
  checks during the gap between state set and defer execution.

- [ ] **BUG-09: tile→maximize→unmaximize leaves huge floating window**
  Steps: tile a window (Super+Left), then maximize it, then unmaximize. Instead of returning to
  tiled position, the window becomes a large floating window. Likely `floatRect` gets overwritten
  with the maximized/fullscreen rect somewhere during the maximize cycle, so when `_doFloat` runs
  on unmaximize it restores to screen-size. Check `_onMaximizeChange` — does it clobber `floatRect`
  before saving `preMaxState`?

- [x] **BUG-01: tile→untile wrong size restore** ✓ resolved
  Was caused by "position only" floatRect update at tile time — size was frozen from map-time
  GSettings value, ignoring actual current window size. Fixed: `_tileWindow` now always snapshots
  full frame rect (position + size).

- [x] **BUG-02: PiP / sticky Chrome window shows in indicator** ✓ resolved

- [ ] **BUG-03: tile→untile pattern fires 3× on rapid keypresses (key repeat)**
  Logs show tile→float×3 before Nautilus unmanages. Likely key-repeat causing multiple keybinding
  fires. Consider debouncing `_tileKeyboard` or using `Meta.KeyBindingFlags.PER_WINDOW`.

- [ ] **BUG-04: First-frame signal can leak if never fired**
  In `_onMap`, the `first-frame` signal handler only disconnects itself on fire. If the window is
  destroyed before first-frame, the connection leaks. Fix: store the signal ID and disconnect in
  `_onUnmanaged`.

- [ ] **BUG-05: Duplicate signal connections for late-registered windows**
  In `_onGrabBegin`, late-registered Chrome windows get `unmanaged`, `workspace-changed`,
  `notify::maximized-*` signals connected. If `_onMap` already connected them (e.g. the window
  DID fire map but wasn't in `_windows` for another reason), we get duplicate handlers.
  Fix: check if already registered before connecting in `_onGrabBegin`.

- [ ] **BUG-06: pendingGeometry overwritten by multiple _doTile calls before first-frame**
  If `_doTile` is called a second time before first-frame fires, `pendingGeometry` is overwritten.
  Only the last geometry is applied. Could affect auto-tile + keyboard tile happening together.

- [ ] **BUG-07: _displaceTile state set before layout update**
  `info.state = 'tiled-${side}'` is set before `layout[side] = win`. If a signal fires between
  these two lines, state won't match layout. Low priority but correctness issue.

- [ ] **BUG-08: Layout key can become orphaned after workspace deletion**
  In `_rebuildLayouts()`, windows where `_winKey()` returns null are skipped via try-catch but
  remain in `this._windows` with a stale layoutKey. These orphaned entries can cause ghost matches
  in `_hasOtherWindows()` and `_checkCoveredFloaters()`.

### Refactoring

- [ ] **REF-01: Extract magic numbers to named constants**
  `33` (drag poll ms), `150` (batch delay ms), `80` (restacked debounce ms), `2000` (size-changed
  timeout ms), `0.9` (tall-window threshold), `0.8` (max tile width), `0.30` (merge threshold),
  `32` (snap px), `20` (drag threshold px). Define at top of file.

- [ ] **REF-02: Extract window signal connection to helper**
  `_connectWindowSignals(win)` — called from `_onMap` AND `_onGrabBegin`. Currently duplicated.
  Also store returned signal IDs for explicit disconnect in `_onUnmanaged`.

- [ ] **REF-03: Extract float rect save/load to single method**
  Float rect snapshot logic appears in 3 places: `_onMap`, `_tileWindow`, `_onGrabBegin` drag
  detach. Extract to `_snapshotFloatRect(win, wa)`.

- [ ] **REF-04: Replace layout key string with typed accessor**
  `"wsIdx:monIdx"` format is parsed with `split(':')` / `parseInt()` in 4+ places. Create
  `_makeLayoutKey(wsIdx, monIdx)` and `_parseLayoutKey(key)` helpers. Or use a `Map` keyed by
  `{ws, mon}` pairs.

- [ ] **REF-05: Break up _updateIndicator into smaller pieces**
  Currently 60+ line method. Extract `_buildLogoButton()`, `_buildWorkspaceButton(i, isActive)`.

- [ ] **REF-06: Replace silent try-catch in _saveFloatSize/_loadFloatSize**
  Parse errors silently return null/skip. Should at least LOG() the error so debugging is possible.

- [ ] **REF-07: Extract _onUnmaximized pre-ws-return logic**
  Lines 540–570 in `_onUnmaximized` handle "return to previous workspace" — a self-contained 30-
  line block. Extract to `_tryReturnToPrevWorkspace(win, info, prev)`.

- [ ] **REF-08: Unify workspace window list filtering**
  `ws.list_windows().filter(w => this._isRelevant(w) && w.get_workspace() === ws)` repeated
  throughout. Extract to `_getRelevantWindows(ws)`.

- [ ] **REF-09: State machine validation**
  Window state is a plain string. Create `setState(win, newState)` helper that validates the
  transition and logs it, making state bugs easier to catch.

- [ ] **REF-10: Decompose the monolithic class** *(large, non-urgent)*
  1648-line single class. Natural split:
  - `TileManager` — tileWindow, doTile, doFloat, tileKeyboard
  - `DragManager` — onGrabBegin/End, pollDrag, finalizeDrag
  - `WorkspaceManager` — moveToNewWorkspace, batch logic
  - `FloaterManager` — checkCoveredFloaters, tryRelocate*
  - `IndicatorManager` — updateIndicator, scheduleUpdate
  - Extension class becomes thin coordinator

### Performance

- [ ] **PERF-01: _isFullyCovered uses O(n²) indexOf**
  `sorted.indexOf(cw)` called for each covering window inside `_isFullyCovered`. Use a `Map<win,
  idx>` built once from `sorted` to get O(n).

- [ ] **PERF-02: _updateIndicator rebuilds entire indicator on every change**
  `destroy_all_children()` + full rebuild on each idle. Instead, diff workspaces and only
  update changed ones. Low priority — only runs on idle.

### UX / Polish

- [x] **UX-01: PiP / skip_pager windows in indicator** ✓ resolved
  Filter: `!w.on_all_workspaces && !w.skip_pager && w.get_workspace() === ws`

---

## Recent Session Log

**2025-03:**
- Fixed Chrome async geometry: one-shot `size-changed` handler re-applies tile geometry
- Fixed Chrome tab-detach: late-register in `_onGrabBegin` op=1025
- Added panel indicator replacing GNOME workspace dots
- Abandoned luminosity-to-alpha shader effect (`Shell.GLSLEffect` doesn't work on `St.Icon` actors)
- Using `Clutter.DesaturateEffect` for inactive workspace icons

**2026-03:**
- Replaced logo SVG with custom `bwm_icon.svg` (4 white squares, 2×2 grid)
- Fixed BUG-01: tile→untile wrong size restore — removed "position only" floatRect guard that
  was incorrectly added to protect against Nautilus async restore (apps don't do that — we own geometry)
- Fixed BUG-02: PiP/sticky windows in indicator (`!w.skip_pager && w.get_workspace() === ws`)
