# Borshevik Workspace Manager — New Architecture Requirements

> This file documents the requirements for the new extension architecture.
> Updated incrementally as development progresses.

---

## Principles

1. **Each window action is one function** with explicit parameters. No flags, no shared state threaded between steps.
2. **Functions own their workspace logic.** If a new workspace needs to be created — they create it. If a free slot exists — they take it. Callers say *what* they want, not *how* to do it.
3. **One code path per action.** Tiling from keyboard, on window open, on return from displacement — all go through the same `tileWindow()`.
4. **State lives on the window** (`win._bwmState`, `win._bwmFloatRect`, etc.). Not in Maps, not in index-keyed structures.
5. **Layout is computed on demand** via `getLayout(ws, mon)` — scans live windows, always consistent.

---

## Blocking window

A window is considered **blocking** if:
- `win.fullscreen === true`, or
- `win.get_maximized() === Meta.MaximizeFlags.BOTH`, or
- `win._bwmState === 'maximized'`

Use a single `isBlocking(win)` helper everywhere. Never use `maximized_horizontally` / `maximized_vertically` anywhere in the codebase.

---

## API — window actions

### `tileWindow(win, { ws?, side? })`

Tiles a window. Resolves workspace and slot internally.

**Logic:**
1. `ws` not provided → use window's current workspace
2. `side` not provided → find first free slot (left preferred)
3. Target slot is free → tile there
4. Target slot occupied by a **blocking window** (fullscreen/maximized) → create new workspace to the right, tile there
5. Target slot occupied by a **tile**, other side is free → swap occupant to other side
6. Both slots occupied by **tiles** → `displaceWindow(occupant)`, then tile
7. No free slot anywhere → create new workspace to the right, tile there

**Called from:**
- `Super+Left / Super+Right` (keyboard) → `tileWindow(win, { side })`
- New window auto-placement (tall-window) → `tileWindow(win, {})`
- Returning a displaced tile to its origin → `tileWindow(win, { ws: originWs, side: originSide })`
- After unmaximize when preMaxState was tiled → `tileWindow(win, { ws: originWs, side })`
- Drag snap to edge → `tileWindow(win, { side })`
- User manually moved a tiled window to another workspace → `tileWindow(win, {})`

---

### `untileWindow(win)`

Removes tile, transitions to float. Frees the slot and triggers return of displaced windows.

**Logic:**
1. Transition to float (`floatWindow(win)`)
2. Free the tile slot
3. Call `returnToOrigin` for any windows displaced from that slot

**Called from:**
- `Super+Left / Super+Right` when window is already tiled on that side
- Drag of tiled window past movement threshold (lazy-detach)

---

### `maximizeWindow(win, { ws? })`

Maximizes a window. Creates a new workspace if the target is occupied.

**Logic:**
1. `ws` not provided → use current workspace
2. Workspace has other windows → create new workspace to the right, move there, maximize
3. Workspace is empty → maximize in place

**Called from:**
- Drag snap to top edge
- `placeNewWindow` when wr > 0.9 and hr > 0.9
- `notify::maximized-*` / `notify::fullscreen` (user maximized the window themselves)

---

### `unmaximizeWindow(win)`

Removes maximize, restores previous state.

**Logic:**
1. Read `win._bwmPreMax` and `win._bwmOrigin`
2. preMax = 'tiled-*' and origin workspace has a free slot → `tileWindow(win, { ws: originWs, side })`
3. preMax = 'floating' and origin workspace exists → move there, `floatWindow(win)`
4. No origin or origin is occupied → restore on current workspace (tile or float)
5. Called during drag → do nothing, drag finalizer handles state

**Called from:**
- `notify::maximized-*` (user unmaximized the window)

---

### `floatWindow(win)`

Transitions window to float, restores geometry.

**Logic:**
1. `win._bwmFloatRect` exists → restore to that rect
2. Saved geometry in GSettings exists → restore proportionally
3. Nothing saved → wait for `size-changed`, then centre

**Called from:**
- `untileWindow`
- `unmaximizeWindow` when preMax = 'floating'
- `placeNewWindow` for ordinary windows (leave as-is)

---

### `placeNewWindow(win)`

Entry point for a newly opened window. Classifies and delegates to the appropriate action.

**Logic:**
| Condition | Action |
|-----------|--------|
| `isBlocking(win)` + workspace has other windows | `maximizeWindow(win)` — will create new ws itself |
| `isBlocking(win)` + workspace is empty | `maximizeWindow(win)` — stays in place |
| hr > 0.9, wr 0.2–0.8 | `tileWindow(win, {})` — finds slot or creates ws itself |
| otherwise | leave as float |
| rule `openOnNewWorkspace` | `moveToRuleWorkspace(win, ruleId)` |

**Batch:** windows opening within 150ms are processed together — so Chrome session restore windows settle before placement decisions are made, avoiding conflicts.

---

### `displaceWindow(win)`

Moves a tiled window off its workspace to the left, freeing its slot.

**Logic:**
1. Search workspaces to the left of current: slot for the needed side is free AND all tiles there were also displaced from the same source workspace (don't intrude on independently placed tiles)
2. Found one → `tileWindow(occupant, { ws: foundWs, side })`
3. Not found → create new workspace to the left, `tileWindow(occupant, { ws: newWs, side })`
4. Record `win._bwmOrigin = { ws: srcWs, side }` for later `returnToOrigin`

**Called from:**
- `tileWindow` when both slots are occupied by tiles

---

### `returnToOrigin(win)`

Returns a displaced window to the slot it was moved from.

**Logic:**
1. Read `win._bwmOrigin`
2. Origin slot is occupied → do nothing
3. Origin slot is free:
   - `win._bwmState` = 'tiled-*' → `tileWindow(win, { ws: originWs, side: originSide })`
   - `win._bwmState` = 'floating' → move to originWs, `floatWindow(win)`
4. Origin workspace has a blocking window → do not return

**Called from:**
- `untileWindow` (slot was freed)
- `onUnmanaged` (window closed, slot freed)
- Drag detach of tiled window (slot freed)

---

### `relocateFloater(win)`

Moves a covered floater somewhere it will be visible.

**Logic:**
1. Free area exists on current workspace → move there (move_frame only, no workspace change)
2. No free area → previous workspace has room → move there
3. Nowhere has room → create new workspace to the left, move there (batch: multiple floaters share one new workspace)

Do not relocate floaters with `above=true`, `transient_for` set, or `_bwmJustMoved`.

**Called from:**
- `onRestacked` (debounced 80ms) — when z-order changed and a floater ended up covered

---

## Helpers (not window actions)

### `getLayout(ws, mon) → { left, right }`
Computes current tile layout for ws:mon. Scans live windows. A blocker (fullscreen/maximized) occupies both slots.

### `isBlocking(win) → bool`
`win.fullscreen || win.get_maximized() === Meta.MaximizeFlags.BOTH || win._bwmState === 'maximized'`

### `isTileable(win) → bool`
Window is a candidate for auto-tiling: hr > 0.9, wr 0.2–0.8.

### `getFreeArea(ws, mon, wa) → rect | null`
Free area on a workspace for a floater. Returns null if there is a blocking window or both tile slots are occupied.

### `defer(fn)`
Schedule execution on next idle (Meta.LaterType.IDLE).

---

## Window state fields

```
win._bwmState        'floating' | 'tiled-left' | 'tiled-right' | 'maximized'
win._bwmFloatRect    { x, y, width, height } | undefined
win._bwmPreMax       string | undefined  — state before maximize
win._bwmOrigin       { ws: MetaWorkspace, side?: string } | undefined
win._bwmMoving       bool — we initiated a workspace change (ignore workspace-changed signal)
win._bwmHandled      bool — passed through placeNewWindow (batch dedup)
win._bwmJustMoved    bool — user just manually moved window (skip covered-floater check once)
win._bwmAppliedRules Set<uuid>
win._bwmTiledWs      MetaWorkspace — workspace where window was tiled (needed at unmanaged time)
win._bwmTiledMon     number — monitor where window was tiled (get_monitor() returns -1 at unmanaged)
```

`_bwmFloatRect` and GSettings float-sizes **must only be set from manual actions** (keyboard, drag). Never from auto-tile paths.

---

## Platform constraints (not architecture)

- **Chrome async geometry:** after unmaximize Chrome restores its pre-maximize position after we apply tile geometry. Fix: one-shot `size-changed` → re-apply geometry.
- **Move serialization:** simultaneous workspace creation corrupts indices. Fix: `_moveQueue` serializes moves.
- **notify::maximized double-fire:** both `notify::maximized-h` and `notify::maximized-v` fire for one operation. Fix: state-based dedup in the signal handler.
- **Chrome tab-detach:** no `map` signal on Wayland for detached tab windows. Fix: late-register in `grab-op-begin`.
- **150ms batch:** Chrome session restore opens many windows simultaneously. Batch window lets them settle before placement.
