/* extension.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St   from 'gi://St';
import Gio  from 'gi://Gio';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

let   LOG    = () => {};   // enabled by debug-logging setting
const SNAP_PX        = 32;
const DRAG_THRESHOLD = 20;  // px cursor must travel before snap zones activate
const MERGE_THRESHOLD = 0.30; // max fractional width mismatch allowed for tile merging

export default class BorshevikWorkspaceManager extends Extension {

    constructor(metadata) {
        super(metadata);

        // Persistent state — survives enable/disable cycles (e.g. screen lock/unlock).
        // Never cleared in disable(); windows remain tracked across lock/unlock.

        // MetaWindow → { state, preMaxState, floatRect, layoutKey }
        this._windows = new Map();

        // "wsIdx:monIdx" → { left: MetaWindow|null, right: MetaWindow|null }
        this._layouts = new Map();

        // Suppress re-entrant notify::maximized-* while we issue window ops
        this._suppress = new Set();

        // Windows being moved by us — skip workspace-changed auto-tile
        this._moving = new Set();

        // Workspaces we created for auto-tiling — only these trigger auto-navigate on empty
        this._ourWorkspaces = new Set();

        // Queue for serialising concurrent _moveToNewWorkspace calls
        this._moveQueue    = [];
        this._moveInFlight = false;

        // Windows already scheduled for blocker-eviction — dedup so two tiles arriving
        // simultaneously don't each try to evict the same blocker.
        this._pendingEvictions = new Set();

        // Windows that have already been through _handleNewWindow or _restoreInitialState.
        this._handled = new Set();
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    enable() {
        this._settings = this.getSettings();

        const updateLog = () => {
            LOG = this._settings.get_boolean('debug-logging')
                ? (...a) => console.log('[BWM]', ...a) : () => {};
        };
        updateLog();
        this._moveWhenMax = this._settings.get_boolean('move-window-when-maximized');

        // Debounce timer for restacked signal (fires very frequently)
        this._restackedTimer = null;

        // Batch processing for auto-tile: collect windows that map within a short window
        // (~150 ms) and process them together. This ensures Chrome "restore windows" and
        // similar multi-window sessions are seen as a batch, with each window's final
        // size/state already applied before we decide on placement.
        this._pendingBatch  = new Set();
        this._batchTimer    = null;
        this._currentBatch  = null;  // Set<MetaWindow> of the batch being flushed right now

        // Move-drag state
        this._drag        = null;   // { win, monitor }
        this._dragPollId  = null;   // GLib source id for cursor polling
        this._snapSide    = null;   // null | 'left' | 'right' | 'maximize'

        // Linked-resize state
        this._resize = null;      // { win, partner }

        // Snap preview — reuse GNOME's own CSS class for free accent-colour theming
        this._preview = new St.Widget({ style_class: 'tile-preview', visible: false });
        Main.layoutManager.uiGroup.add_child(this._preview);

        // Disable GNOME edge-tiling so it doesn't race with ours
        this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
        this._savedEdgeTiling = this._mutterSettings.get_boolean('edge-tiling');
        this._mutterSettings.set_boolean('edge-tiling', false);

        this._handles = [
            [global.window_manager,    global.window_manager.connect('map', (_, act) => this._onMap(act))],
            [global.display,           global.display.connect('grab-op-begin', (_, w, op) => this._onGrabBegin(w, op))],
            [global.display,           global.display.connect('grab-op-end',   (_, w, op) => this._onGrabEnd(w, op))],
            [global.display,           global.display.connect('restacked', () => this._onRestacked())],
            [global.workspace_manager, global.workspace_manager.connect('workspace-removed', () => this._rebuildLayouts())],
            [this._settings,           this._settings.connect('changed::move-window-when-maximized', () => {
                this._moveWhenMax = this._settings.get_boolean('move-window-when-maximized');
            })],
            [this._settings,           this._settings.connect('changed::debug-logging', updateLog)],
        ];
    }

    disable() {
        this._handles.splice(0).forEach(([obj, id]) => obj.disconnect(id));

        if (this._dragPollId) {
            GLib.source_remove(this._dragPollId);
            this._dragPollId = null;
        }
        this._drag = null;

        if (this._batchTimer) {
            GLib.source_remove(this._batchTimer);
            this._batchTimer = null;
        }
        this._pendingBatch.clear(); this._pendingBatch = null;

        if (this._restackedTimer) {
            GLib.source_remove(this._restackedTimer);
            this._restackedTimer = null;
        }

        this._preview.destroy();
        this._preview = null;

        this._mutterSettings.set_boolean('edge-tiling', this._savedEdgeTiling);
        this._mutterSettings = null;

        this._settings = null;
    }

    // ── Small helpers ────────────────────────────────────────────────────────

    _isRelevant(win) {
        return win.window_type === Meta.WindowType.NORMAL &&
            !win.skip_taskbar &&
            !win.is_always_on_all_workspaces();
    }

    _defer(fn) {
        global.compositor.get_laters().add(Meta.LaterType.IDLE, () => { fn(); return false; });
    }

    _toRect(r)   { return { x: r.x, y: r.y, width: r.width, height: r.height }; }

    _saveFloatSize(wmClass, wr, hr) {
        try {
            const map = JSON.parse(this._settings.get_string('float-sizes'));
            map[wmClass] = { wr, hr };
            this._settings.set_string('float-sizes', JSON.stringify(map));
        } catch (_) {}
    }

    _loadFloatSize(wmClass) {
        try {
            const map = JSON.parse(this._settings.get_string('float-sizes'));
            return map[wmClass] ?? null;
        } catch (_) { return null; }
    }
    _winKey(win) {
        const ws = win.get_workspace();
        if (!ws) return null;
        return `${ws.index()}:${win.get_monitor()}`;
    }

    // ── Layout helpers ───────────────────────────────────────────────────────

    _getLayout(key) {
        if (!this._layouts.has(key))
            this._layouts.set(key, { left: null, right: null });
        return this._layouts.get(key);
    }

    _removeFromLayout(win) {
        const key = this._windows.get(win)?.layoutKey;
        if (!key) return;
        const l = this._layouts.get(key);
        if (!l) return;
        if (l.left  === win) l.left  = null;
        if (l.right === win) l.right = null;
        if (!l.left && !l.right) this._layouts.delete(key);
    }

    _rebuildLayouts() {
        this._layouts.clear();

        // Drop any _ourWorkspaces entries whose workspace no longer exists.
        const n = global.workspace_manager.get_n_workspaces();
        const validWs = new Set();
        for (let i = 0; i < n; i++)
            validWs.add(global.workspace_manager.get_workspace_by_index(i));
        for (const ws of this._ourWorkspaces)
            if (!validWs.has(ws)) this._ourWorkspaces.delete(ws);

        for (const [win, info] of this._windows) {
            try { info.layoutKey = this._winKey(win); } catch { continue; }
            if (info.state !== 'tiled-left' && info.state !== 'tiled-right') continue;
            const side = info.state === 'tiled-left' ? 'left' : 'right';
            this._getLayout(info.layoutKey)[side] = win;
        }
    }

    // ── Window signals ───────────────────────────────────────────────────────

    _onMap(act) {
        const win = act.meta_window;
        if (!this._isRelevant(win)) return;

        const r0 = win.get_frame_rect();
        LOG('map:', win.get_wm_class(),
            `ws=${win.get_workspace().index()} mon=${win.get_monitor()}`,
            `max=${win.maximized_horizontally && win.maximized_vertically}`,
            `fs=${win.fullscreen}`,
            `size=${r0.width}x${r0.height}`);

        const info = {
            state:           'floating',
            preMaxState:     null,
            floatRect:       null,
            layoutKey:       this._winKey(win),
            firstFrameFired: false,
            pendingGeometry: null,   // { x, y, w, h } set by _doTile if first-frame not yet fired
        };
        this._windows.set(win, info);

        // Hook first-frame NOW (t=0) so we catch it even for fast-starting apps.
        // By the time our batch timer fires (t=150ms), first-frame may have already
        // fired; we track that via firstFrameFired so _doTile knows which path to take.
        const actor = win.get_compositor_private();
        if (actor) {
            const id = actor.connect('first-frame', () => {
                actor.disconnect(id);
                info.firstFrameFired = true;
                if (info.pendingGeometry && info.state.startsWith('tiled')) {
                    const { x, y, w, h } = info.pendingGeometry;
                    info.pendingGeometry = null;
                    LOG('first-frame: applying pending tile geometry for', win.get_wm_class(), `x=${x} w=${w}`);
                    this._suppress.add(win);
                    win.move_frame(true, x, y);
                    win.move_resize_frame(true, x, y, w, h);
                    this._suppress.delete(win);
                }
            });
        }

        win.connect('unmanaged',         () => this._onUnmanaged(win));
        win.connect('workspace-changed', () => this._onWorkspaceChanged(win));
        win.connect('notify::maximized-horizontally', () => this._onMaximizeChange(win));
        win.connect('notify::maximized-vertically',   () => this._onMaximizeChange(win));
        win.connect('notify::fullscreen',             () => this._onMaximizeChange(win));

        if (!this._moveWhenMax) return;
        this._pendingBatch.add(win);
        this._scheduleBatch();
    }

    _scheduleBatch() {
        if (this._batchTimer) return;  // already waiting
        // 150 ms gives Chrome (and similar) time to apply saved window state
        // (maximize, fullscreen, position) before we decide on placement.
        this._batchTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._batchTimer = null;
            this._flushBatch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushBatch() {
        const wins = [...this._pendingBatch];
        this._pendingBatch.clear();
        // Store the current batch so _handleNewWindow can distinguish
        // "opened simultaneously with me" (skip) from "pre-existing" (count).
        this._currentBatch = new Set(wins);
        LOG(`flushBatch: ${wins.length} window(s)`);
        for (const win of wins) {
            if (this._windows.has(win))
                this._handleNewWindow(win);
        }
        this._currentBatch = null;
    }

    _onUnmanaged(win) {
        LOG('unmanaged:', win.get_wm_class());
        // Capture info now, before we delete the window from our map.
        const info      = this._windows.get(win);
        const layoutKey = info?.layoutKey;
        const closedSide = info?.state === 'tiled-left'  ? 'left'
                         : info?.state === 'tiled-right' ? 'right' : null;
        const ws = layoutKey
            ? global.workspace_manager.get_workspace_by_index(parseInt(layoutKey.split(':')[0]))
            : null;
        const wsIdx = ws ? ws.index() : -1;
        const mon   = layoutKey ? parseInt(layoutKey.split(':')[1]) : -1;

        this._removeFromLayout(win);
        this._windows.delete(win);
        this._handled.delete(win);
        this._pendingBatch.delete(win);

        if (ws)
            this._defer(() => this._leaveIfEmpty(ws));
        if (closedSide !== null && wsIdx >= 0 && mon >= 0)
            this._defer(() => this._collapseIfPossible(wsIdx, closedSide, mon));
    }

    _leaveIfEmpty(ws) {
        const manager = global.workspace_manager;

        // Only auto-navigate away from workspaces we created for tiling.
        // If the user manually navigated to a workspace and closed apps there,
        // it's not our place to redirect them.
        if (!this._ourWorkspaces.has(ws)) return;

        // Find the current index of this workspace (index may have shifted).
        const wsIdx = ws.index();
        if (wsIdx < 0) return;  // workspace already removed

        if (manager.get_active_workspace_index() !== wsIdx) return;  // user moved away already

        const hasWindows = ws.list_windows()
            .some(w => !w.is_always_on_all_workspaces() && this._isRelevant(w));
        if (hasWindows) return;

        const target = manager.get_workspace_by_index(wsIdx - 1);
        if (!target) return;  // leftmost — nothing to the left

        LOG('leaveIfEmpty: ws', wsIdx, '→ ws', wsIdx - 1, '(our workspace, now empty)');
        this._ourWorkspaces.delete(ws);
        target.activate(global.get_current_time());
    }

    _onWorkspaceChanged(win) {
        const info = this._windows.get(win);
        if (!info) return;
        const newKey = this._winKey(win);
        if (!newKey) return;  // win.get_workspace() is null — window is being unmanaged, ignore
        this._removeFromLayout(win);
        this._handled.delete(win);   // reset so it can be re-evaluated on new workspace
        info.layoutKey = newKey;
        // Preserve tiled state so _tileIntoFreeSlot can re-tile on the new workspace,
        // and so drag-begin can restore float size if the user drags before the tile settles.
        // For non-tiled states (maximized, floating) reset to floating.
        if (info.state !== 'tiled-left' && info.state !== 'tiled-right')
            info.state = 'floating';
        LOG('workspace-changed:', win.get_wm_class(), '→', info.layoutKey, this._moving.has(win) ? '(by us)' : '(by user)');
        if (this._moving.has(win)) return;
        // User manually moved the window — raise it to the top so z-order reflects the
        // move, then skip the next coverage check so we don't immediately fly it away.
        win.raise();
        info.justMoved = true;
        // User manually moved the window — respect their choice, only tile if a slot is free.
        // Never force-move to a new workspace.
        if (this._moveWhenMax)
            this._defer(() => this._tileIntoFreeSlot(win));
    }

    _onMaximizeChange(win) {
        if (this._suppress.has(win)) return;
        const info = this._windows.get(win);
        if (!info) return;

        const full = win.fullscreen || (win.maximized_horizontally && win.maximized_vertically);

        // notify::maximized-h and notify::maximized-v both fire for one maximize op.
        // Skip if the state already matches — the second signal is always a no-op.
        if (full === (info.state === 'maximized')) return;

        if (full) {
            if (info.state === 'floating')
                info.floatRect = this._toRect(win.get_frame_rect());
            info.preMaxState = info.state;
            this._removeFromLayout(win);
            info.state = 'maximized';
            LOG('→ maximized:', win.get_wm_class(), 'from', info.preMaxState);
            // Window maximized and there are other windows on this workspace →
            // give it its own workspace. preMaxState is preserved so _onUnmaximized
            // can return it to the correct side (or float) on the previous workspace.
            if (this._moveWhenMax && this._hasOtherWindows(info.layoutKey, win))
                this._defer(() => this._moveToNewWorkspace(win));
        } else {
            this._onUnmaximized(win, info);
        }
    }

    _onUnmaximized(win, info) {
        const prev = info.preMaxState ?? 'floating';
        info.preMaxState = null;

        // Window is being dragged — Mutter unmaximizes it automatically on drag start.
        // Don't schedule a re-tile; let _finalizeDrag handle the final state.
        if (this._drag?.win === win) {
            LOG('← unmaximized during drag:', win.get_wm_class(), '(skipping restore, was', prev, ')');
            info.state = 'floating';
            return;
        }

        LOG('← unmaximized:', win.get_wm_class(), 'restoring', prev);

        // On an auto-created workspace: try to return to the previous workspace.
        // Prefer the side the window came from; fall back to any free slot.
        if (this._moveWhenMax) {
            const currentWs = win.get_workspace();
            if (currentWs && this._ourWorkspaces.has(currentWs)) {
                const prevWsIdx = currentWs.index() - 1;
                const manager   = global.workspace_manager;
                const prevWs    = prevWsIdx >= 0 ? manager.get_workspace_by_index(prevWsIdx) : null;
                if (prevWs) {
                    const monitor    = win.get_monitor();
                    const prevKey    = `${prevWsIdx}:${monitor}`;
                    const prevLayout = this._getLayout(prevKey);

                    let targetSide = null;
                    if      (prev === 'tiled-left'  && !prevLayout.left)  targetSide = 'left';
                    else if (prev === 'tiled-right' && !prevLayout.right) targetSide = 'right';

                    if (targetSide) {
                        LOG('← unmaximized: returning to ws', prevWsIdx, 'side', targetSide);
                        this._moving.add(win);
                        info.state = `tiled-${targetSide}`;
                        win.change_workspace_by_index(prevWsIdx, false);
                        prevWs.activate(global.get_current_time());
                        this._defer(() => {
                            this._moving.delete(win);
                            if (this._windows.has(win))
                                this._tileWindow(win, targetSide);
                        });
                        return;
                    }
                }
            }
        }

        // Default: restore to pre-maximize state on current workspace.
        if (prev === 'tiled-left' || prev === 'tiled-right') {
            const side   = prev === 'tiled-left' ? 'left' : 'right';
            const layout = this._getLayout(info.layoutKey);

            if (!layout[side] || layout[side] === win) {
                this._defer(() => { if (this._windows.has(win)) this._tileWindow(win, side); });
            } else {
                // Side taken — restore to float
                info.state = 'floating';
                this._defer(() => this._doFloat(win));
            }
        } else {
            info.state = 'floating';
            this._defer(() => this._doFloat(win));
        }
    }

    // ── Grab-op: drag & resize ───────────────────────────────────────────────

    _onGrabBegin(win, op) {
        LOG('grab-op-begin:', win?.get_wm_class() ?? 'null', `op=${op}`, `tracked=${!!win && this._windows.has(win)}`);
        if (!win || !this._windows.has(win)) return;

        if (op === Meta.GrabOp.MOVING) {
            LOG('drag-begin:', win.get_wm_class());

            // Set _drag FIRST — before any window ops that might trigger notify::maximized-*.
            // Mutter auto-unmaximizes windows when drag starts; our _onUnmaximized guard
            // (`if (this._drag?.win === win)`) must see _drag already set when that fires.
            const [startX, startY] = global.get_pointer();
            this._drag = { win, monitor: win.get_monitor(), startX, startY, tiledSide: null };

            const info = this._windows.get(win);

            // If tiled — remember which side, but don't detach yet.
            // We detach lazily once the cursor crosses DRAG_THRESHOLD, so brief
            // accidental clicks on the title bar don't cause an untile.
            if (info?.state === 'tiled-left' || info?.state === 'tiled-right') {
                this._drag.tiledSide = info.state === 'tiled-left' ? 'left' : 'right';
                LOG('drag-begin: tiled-', this._drag.tiledSide, '— will detach at threshold');
            }
            // Use timeout_add (30fps) instead of idle_add: during Mutter grab-op,
            // DEFAULT_IDLE callbacks are starved and never fire.
            this._dragPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
                if (!this._drag) return GLib.SOURCE_REMOVE;
                this._pollDrag();
                return GLib.SOURCE_CONTINUE;
            });
            return;
        }

        // Resize — only care about tiled windows
        const info = this._windows.get(win);
        if (!info?.state.startsWith('tiled')) return;
        const layout  = this._layouts.get(info.layoutKey);
        if (!layout) return;
        const partner = layout.left === win ? layout.right : layout.left;
        if (!partner) return;
        LOG('resize-begin:', win.get_wm_class(), '| partner:', partner.get_wm_class());
        this._resize = { win, partner };
    }

    _onGrabEnd(win, _op) {
        if (this._drag?.win === win) {
            GLib.source_remove(this._dragPollId);
            this._dragPollId = null;
            this._finalizeDrag(win);
            this._drag     = null;
            this._hidePreview();
            this._snapSide = null;
        }

        if (this._resize?.win === win) {
            this._finalizeResize();
            this._resize = null;
        }
    }

    _pollDrag() {
        const win = this._drag?.win;
        if (!win) return;
        const [cx, cy] = global.get_pointer();

        // Track which monitor the cursor is on
        let monIdx = 0;
        for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
            const m = Main.layoutManager.monitors[i];
            if (cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height) {
                monIdx = i; break;
            }
        }
        this._drag.monitor = monIdx;

        const wa   = win.get_work_area_for_monitor(monIdx);
        let   snap = null;
        const dist = Math.hypot(cx - this._drag.startX, cy - this._drag.startY);
        if (dist >= DRAG_THRESHOLD) {
            // Lazy detach: first time we cross the threshold for a tiled window, untile it now.
            if (this._drag.tiledSide !== null) {
                const info = this._windows.get(win);
                if (info && (info.state === 'tiled-left' || info.state === 'tiled-right')) {
                    LOG('drag: threshold crossed — detaching tile', win.get_wm_class());
                    this._removeFromLayout(win);
                    info.state = 'floating';
                    if (!info.floatRect) {
                        const saved = this._loadFloatSize(win.get_wm_class());
                        if (saved) {
                            const fr = win.get_frame_rect();
                            info.floatRect = { x: fr.x, y: fr.y,
                                width:  Math.round(wa.width  * saved.wr),
                                height: Math.round(wa.height * saved.hr) };
                        }
                    }
                    if (info.floatRect) {
                        const cur = win.get_frame_rect();
                        this._suppress.add(win);
                        win.move_resize_frame(false, cur.x, cur.y, info.floatRect.width, info.floatRect.height);
                        this._suppress.delete(win);
                    }
                }
                this._drag.tiledSide = null;  // threshold crossed — won't re-dock on release
            }
            if      (cx <= wa.x + SNAP_PX)              snap = 'left';
            else if (cx >= wa.x + wa.width - SNAP_PX)   snap = 'right';
            else if (cy <= wa.y + SNAP_PX)               snap = 'maximize';
        }

        if (snap !== this._snapSide) {
            this._snapSide = snap;
            LOG('snap-zone:', snap ?? 'none');
            snap ? this._showPreview(snap, wa) : this._hidePreview();
        }
    }

    // ── Preview ──────────────────────────────────────────────────────────────

    _showPreview(side, wa) {
        const half = Math.floor(wa.width / 2);
        const map  = {
            left:     [wa.x,        wa.y, half,           wa.height],
            right:    [wa.x + half, wa.y, wa.width - half, wa.height],
            maximize: [wa.x,        wa.y, wa.width,        wa.height],
        };
        const [x, y, w, h] = map[side];
        this._preview.set_position(x, y);
        this._preview.set_size(w, h);
        this._preview.show();
    }

    _hidePreview() { this._preview.hide(); }

    // ── Drag finalize ────────────────────────────────────────────────────────

    _finalizeDrag(win) {
        const info = this._windows.get(win);
        if (!info) return;

        if (!this._snapSide) {
            LOG('drag-end:', win.get_wm_class(), '(no snap)');
            // Threshold not reached — state/layout were never touched, nothing to do
            if (this._drag.tiledSide !== null) {
                LOG('drag-end: click-only, tile unchanged');
                return;
            }
            // Threshold was reached — window is already floating; nothing left to do
            return;
        }

        // Sync layout key to where the window actually landed
        const newKey = `${win.get_workspace().index()}:${this._drag.monitor}`;
        if (newKey !== info.layoutKey) {
            LOG('drag-end: monitor/ws changed', info.layoutKey, '→', newKey);
            this._removeFromLayout(win);
            info.layoutKey = newKey;
        }

        LOG('drag-end:', win.get_wm_class(), '→ snap', this._snapSide);
        if (this._snapSide === 'maximize') {
            this._doMaximize(win);
        } else {
            // Save float size only if we have a genuine floatRect from this session.
            // If floatRect is null, the window opened at tile-size and never had a real float
            // history — saving it would overwrite a good previously-stored size.
            const info2 = this._windows.get(win);
            if (info2?.floatRect) {
                const wa2 = win.get_work_area_for_monitor(this._drag.monitor);
                this._saveFloatSize(win.get_wm_class(),
                    info2.floatRect.width  / wa2.width,
                    info2.floatRect.height / wa2.height);
            }
            this._evictBlockerIfPresent(info.layoutKey);
            this._tileWindow(win, this._snapSide);
        }
    }

    // ── Resize finalize ──────────────────────────────────────────────────────

    _finalizeResize() {
        const { win, partner } = this._resize;
        const info = this._windows.get(win);
        if (!info) return;

        const wa   = win.get_work_area_current_monitor();
        const rect = win.get_frame_rect();
        let px, pw;

        if (info.state === 'tiled-left') {
            px = rect.x + rect.width;
            pw = (wa.x + wa.width) - px;
        } else {
            px = wa.x;
            pw = rect.x - wa.x;
        }

        if (pw < 50) {
            LOG('resize-end: partner too narrow, skip');
            return;
        }

        LOG('resize-end:', win.get_wm_class(), '| partner', partner.get_wm_class(), `→ x=${px} w=${pw}`);
        this._suppress.add(partner);
        partner.move_resize_frame(false, px, wa.y, pw, wa.height);
        this._suppress.delete(partner);
    }

    // ── Core window ops ──────────────────────────────────────────────────────

    /** Tile win to side. If target side is taken, displaces the occupant.
     *  overrideW sets a custom tile width (null = half screen). */
    _tileWindow(win, side, overrideW = null) {
        const info = this._windows.get(win);
        if (!info) return;

        const layout = this._getLayout(info.layoutKey);

        // Vacate win's current slot so swap math is clean
        if (layout.left  === win) layout.left  = null;
        if (layout.right === win) layout.right = null;

        const wa       = win.get_work_area_current_monitor();
        const occupant = layout[side];

        if (occupant && occupant !== win) {
            const other = side === 'left' ? 'right' : 'left';
            if (layout[other]) {
                // Both sides occupied — displace the occupant of our target side.
                // New window takes the slot; occupant tries to merge into ws+1 or gets a new ws.
                this._displaceTile(occupant, side, win.get_monitor());
                layout[side] = null;
            } else {
                // Other side is free — swap occupant there.
                // Capture width before any resize so the split line is preserved.
                const occupantW = occupant.get_frame_rect().width;
                // Set state BEFORE _doTile so the applyGeometry guard sees 'tiled-*'.
                const oi = this._windows.get(occupant);
                if (oi) oi.state = `tiled-${other}`;
                layout[other] = occupant;
                this._doTile(occupant, other, wa, occupantW);
                // Dragged window fills the remaining space — set overrideW now so the
                // partner-aware calc below doesn't re-read a potentially stale frame rect.
                overrideW = wa.width - occupantW;
            }
        }

        if (info.state === 'floating') {
            if (info.floatRect) {
                // Already has a float rect from this session — just refresh position.
                info.floatRect = this._toRect(win.get_frame_rect());
            } else {
                // No float history in memory — try persisted size first.
                const saved = this._loadFloatSize(win.get_wm_class());
                const fr    = win.get_frame_rect();
                if (saved) {
                    info.floatRect = { x: fr.x, y: fr.y,
                        width:  Math.round(wa.width  * saved.wr),
                        height: Math.round(wa.height * saved.hr) };
                } else {
                    // First time ever tiling this class — seed GSettings with the initial size.
                    info.floatRect = this._toRect(fr);
                    this._saveFloatSize(win.get_wm_class(), fr.width / wa.width, fr.height / wa.height);
                }
            }
        }

        // If no explicit width given, fill the space left by the partner rather than
        // defaulting to half-screen. This preserves custom tile splits on re-tile.
        if (overrideW === null) {
            const other   = side === 'left' ? 'right' : 'left';
            const partner = layout[other];
            if (partner) {
                const pi = this._windows.get(partner);
                // Use pending geometry width if the partner's first frame hasn't fired yet
                // (get_frame_rect would return the pre-tile size and corrupt the split).
                const pw = pi?.pendingGeometry?.w ?? partner.get_frame_rect().width;
                overrideW = wa.width - pw;
            }
        }

        // Set state BEFORE _doTile so the applyGeometry guard inside sees 'tiled-*'.
        info.state   = `tiled-${side}`;
        layout[side] = win;
        this._doTile(win, side, wa, overrideW);
        LOG('tile:', win.get_wm_class(), '→', side, overrideW !== null ? `w=${overrideW}` : '');
    }

    /** Raw geometry tile — no state or layout updates. */
    _doTile(win, side, wa = null, overrideW = null) {
        if (!wa) wa = win.get_work_area_current_monitor();
        const half = Math.floor(wa.width / 2);
        const w    = overrideW !== null ? overrideW : (side === 'left' ? half : wa.width - half);
        const x    = side === 'left' ? wa.x : wa.x + wa.width - w;

        const hadState = win.fullscreen || win.maximized_horizontally || win.maximized_vertically;

        const info = this._windows.get(win);

        const applyGeometry = () => {
            if (!this._windows.has(win)) return;
            // Guard: if user untiled the window before we apply, don't force it back
            if (!this._windows.get(win)?.state.startsWith('tiled')) return;
            this._suppress.add(win);
            // Two-call pattern (same as Tiling Assistant / Pop Shell):
            // some apps (Chrome, Terminal) only resize but don't move on a combined
            // move_resize_frame call. move_frame first, then move_resize_frame to fix that.
            // user_op=true prevents Mutter from applying screen-edge constraints.
            win.move_frame(true, x, wa.y);
            win.move_resize_frame(true, x, wa.y, w, wa.height);
            this._suppress.delete(win);
        };

        if (hadState) {
            // Tell Mutter this is an unmaximize transition before we touch the window.
            // This makes move_resize_frame reliable immediately after unmaximize — the same
            // pattern used by Tiling Assistant and tilingshell.
            const actor = win.get_compositor_private();
            if (actor) {
                try {
                    Main.wm._prepareAnimationInfo(
                        global.window_manager, actor,
                        win.get_frame_rect().copy(),
                        Meta.SizeChange.UNMAXIMIZE);
                } catch {}
            }
            this._suppress.add(win);
            if (win.fullscreen)
                win.unmake_fullscreen();
            if (win.maximized_horizontally || win.maximized_vertically)
                win.unmaximize();
            applyGeometry();   // apply synchronously — no defer needed with _prepareAnimationInfo
            this._suppress.delete(win);
        } else if (info && !info.firstFrameFired) {
            // Window hasn't drawn its first frame yet — move_resize_frame sent now
            // will be queued behind the initial configure roundtrip and may be ignored.
            // Store the geometry; the first-frame handler in _onMap will apply it.
            LOG('_doTile: first-frame not yet fired, storing pending geometry for', win.get_wm_class());
            info.pendingGeometry = { x, y: wa.y, w, h: wa.height };
        } else {
            // Window already drew — apply directly.
            applyGeometry();
        }
    }

    _doMaximize(win) {
        const info = this._windows.get(win);
        if (!info) return;
        if (info.state === 'maximized') return;  // already maximized — don't corrupt preMaxState
        if (info.state === 'floating')
            info.floatRect = this._toRect(win.get_frame_rect());
        info.preMaxState = info.state;  // save BEFORE any ops so state is still the real prior state
        this._removeFromLayout(win);
        this._suppress.add(win);
        win.maximize();
        this._suppress.delete(win);
        info.state = 'maximized';
        LOG('maximize:', win.get_wm_class(), 'preMaxState:', info.preMaxState);
    }

    _doFloat(win) {
        const info = this._windows.get(win);
        if (!info) return;
        const { x, y, width, height } = info.floatRect ?? this._toRect(win.get_frame_rect());
        LOG('float:', win.get_wm_class(), `→ (${x},${y},${width},${height})`);
        this._suppress.add(win);
        win.move_frame(true, x, y);
        win.move_resize_frame(true, x, y, width, height);
        this._suppress.delete(win);
        info.state = 'floating';
    }

    // ── Auto-tile logic ──────────────────────────────────────────────────────

    /** Called when user manually moves a window to another workspace.
     *  - Empty workspace + window was tiled → re-tile on the same side (next window fills the other).
     *  - One slot occupied → fill the free slot.
     *  - Both slots taken → leave floating.
     *  Never forces a move to a new workspace. */
    _tileIntoFreeSlot(win) {
        if (this._drag?.win === win) return;  // dragging — drag logic handles state
        const info = this._windows.get(win);
        if (!info) return;
        const layout = this._getLayout(info.layoutKey);

        // If a previous queued callback already placed this window correctly, skip.
        if (info.state === 'tiled-left'  && layout.left  === win) return;
        if (info.state === 'tiled-right' && layout.right === win) return;

        if (!layout.left && !layout.right) {
            // Empty workspace: re-tile on the same side if the window was tiled,
            // otherwise leave floating (no change needed).
            if (info.state === 'tiled-left')        this._tileWindow(win, 'left');
            else if (info.state === 'tiled-right')  this._tileWindow(win, 'right');
        } else if (layout.left && !layout.right) {
            this._tileWindow(win, 'right');
        } else if (!layout.left && layout.right) {
            this._tileWindow(win, 'left');
        } else {
            // Both slots taken — drop to floating
            info.state = 'floating';
        }
        LOG('tileIntoFreeSlot:', win.get_wm_class(), '→', info.state);
    }

    _handleNewWindow(win) {
        const info = this._windows.get(win);
        if (!info) return;

        // Mark handled immediately so concurrent arrivals in the same idle batch
        // can count this window as "settled" when deciding their own placement.
        this._handled.add(win);

        const layout = this._getLayout(info.layoutKey);

        const winIsBlocking = win.fullscreen ||
            (win.maximized_horizontally && win.maximized_vertically) ||
            info.state === 'maximized';

        // Check whether any other window on this ws:monitor already exists.
        // For non-blocking windows: exclude same-batch unprocessed windows (they haven't
        // settled yet). For blocking windows: same-batch windows DO count — they will
        // end up on this workspace and the maximized window must not cover them.
        let hasExistingOther = false;
        for (const [w, wi] of this._windows) {
            if (w === win) continue;
            if (wi.layoutKey !== info.layoutKey) continue;
            // For non-blocking: same batch but not yet processed → skip
            if (!winIsBlocking && this._currentBatch?.has(w) && !this._handled.has(w)) continue;
            hasExistingOther = true;
            break;
        }

        const slotsUsed = (layout.left ? 1 : 0) + (layout.right ? 1 : 0);

        LOG('handleNewWindow:', win.get_wm_class(), `key=${info.layoutKey}`,
            `left=${layout.left?.get_wm_class() ?? '-'} right=${layout.right?.get_wm_class() ?? '-'}`,
            `existing=${hasExistingOther} slots=${slotsUsed} blocking=${winIsBlocking}`);

        // Maximized/fullscreen new windows that would cover existing content → new workspace.
        if (winIsBlocking && (hasExistingOther || slotsUsed >= 1)) {
            this._moveToNewWorkspace(win);
            return;
        }

        // All other windows (including floating): use _restoreInitialState.
        // Tall windows get auto-tiled; floating windows stay floating.
        // _onFocusChanged will relocate covered floaters later.
        this._restoreInitialState(win);
    }

    /** If there is a maximized/fullscreen blocker on layoutKey, schedule its eviction to the left.
     *  Deduplicates: safe to call from multiple simultaneous tiles for the same workspace. */
    _evictBlockerIfPresent(layoutKey) {
        if (!this._moveWhenMax) return;
        for (const [blocker, bi] of this._windows) {
            if (bi.layoutKey !== layoutKey) continue;
            if (this._moving.has(blocker)) continue;
            if (this._pendingEvictions.has(blocker)) continue;
            if (blocker.fullscreen || bi.state === 'maximized') {
                LOG('evictBlocker:', blocker.get_wm_class(), '← left from', layoutKey);
                this._pendingEvictions.add(blocker);
                this._defer(() => {
                    this._pendingEvictions.delete(blocker);
                    if (this._windows.has(blocker))
                        this._moveToNewWorkspace(blocker, null, 'left');
                });
                break;
            }
        }
    }

    /** Returns true if there are any other tracked windows on this ws:monitor (excluding win itself). */
    _hasOtherWindows(layoutKey, excludeWin) {
        for (const [w, wi] of this._windows) {
            if (w === excludeWin) continue;
            if (wi.layoutKey !== layoutKey) continue;
            return true;
        }
        return false;
    }

    _restoreInitialState(win) {
        // Track as settled so future windows on this ws:monitor count it as existing content
        this._handled.add(win);

        const wa   = win.get_work_area_current_monitor();
        const rect = win.get_frame_rect();
        const wr   = rect.width  / wa.width;
        const hr   = rect.height / wa.height;
        LOG('restoreInitialState:', win.get_wm_class(), `wr=${wr.toFixed(2)} hr=${hr.toFixed(2)}`);

        if (wr > 0.9 && hr > 0.9) {
            this._doMaximize(win);
        } else if (hr > 0.9 && wr >= 0.2 && wr <= 0.8) {
            // Tall window — tile with its own width (capped at 80% of work area)
            const customW     = Math.min(rect.width, Math.floor(wa.width * 0.8));
            const preferred   = (rect.x + rect.width / 2) > (wa.x + wa.width / 2) ? 'right' : 'left';
            const layout      = this._getLayout(this._windows.get(win)?.layoutKey ?? '');
            const other       = preferred === 'left' ? 'right' : 'left';
            // Prefer the free side to avoid displacing existing tiles.
            // Fall back to preferred if it's free, or other if preferred is taken.
            // Don't tile if both sides are already occupied.
            const side = !layout[preferred] ? preferred : !layout[other] ? other : null;
            if (side !== null) {
                this._evictBlockerIfPresent(this._windows.get(win)?.layoutKey);
                // If a partner already occupies the other side, pass null so _tileWindow
                // computes the remaining width. Otherwise use the window's natural width.
                const otherSide = side === 'left' ? 'right' : 'left';
                this._tileWindow(win, side, layout[otherSide] ? null : customW);
            }
        }
        // otherwise leave floating
    }

    // ── Covered-floater relocation ───────────────────────────────────────────

    _onRestacked() {
        if (!this._moveWhenMax) return;
        // Debounce: restacked fires for every Z-order change, batch rapid events.
        if (this._restackedTimer) return;
        this._restackedTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._restackedTimer = null;
            // Check all layout keys that have at least one covering window.
            const keysToCheck = new Set();
            for (const [win, wi] of this._windows) {
                if (!wi.layoutKey) continue;
                if (win.fullscreen || wi.state === 'maximized' || wi.state?.startsWith('tiled'))
                    keysToCheck.add(wi.layoutKey);
            }
            for (const key of keysToCheck)
                this._checkCoveredFloaters(key);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Check all floating windows on key and relocate any that are covered by type-1 windows. */
    _checkCoveredFloaters(key) {
        if (!this._moveWhenMax) return;

        const [wsIdxStr, monIdxStr] = key.split(':');
        const wsIdx = parseInt(wsIdxStr);
        const mon   = parseInt(monIdxStr);
        const ws    = global.workspace_manager.get_workspace_by_index(wsIdx);
        if (!ws) return;

        // Collect covering (type-1) windows on this key
        const coveringWins = [];
        for (const [win, wi] of this._windows) {
            if (wi.layoutKey !== key) continue;
            if (win.fullscreen || wi.state === 'maximized' || wi.state?.startsWith('tiled'))
                coveringWins.push(win);
        }
        LOG('checkCoveredFloaters key=', key, 'covering=', coveringWins.map(w => w.get_wm_class()));
        if (coveringWins.length === 0) return;

        // Get work area
        let wa = null;
        for (const [w, wi] of this._windows) {
            if (wi.layoutKey === key) { wa = w.get_work_area_for_monitor(mon); break; }
        }
        if (!wa) return;

        // Z-order: bottom=0, top=last
        const allWins = ws.list_windows().filter(w =>
            w.get_monitor() === mon && !w.is_always_on_all_workspaces()
        );
        const sorted   = global.display.sort_windows_by_stacking(allWins);
        const freeArea = this._getFreeArea(key, wa);

        const coveredFloaters = [];
        for (const [floatWin, wi] of this._windows) {
            if (wi.layoutKey !== key) continue;
            if (wi.state !== 'floating') continue;
            if (floatWin.above) continue;
            if (floatWin.is_always_on_all_workspaces()) continue;
            // Skip windows just moved here by the user — clear the flag and leave them alone.
            if (wi.justMoved) { wi.justMoved = false; continue; }
            if (this._moving.has(floatWin)) continue;
            const parent = floatWin.get_transient_for();
            if (parent && this._windows.get(parent)?.layoutKey === key) continue;

            const floatIdx = sorted.indexOf(floatWin);
            if (floatIdx === -1) continue;

            const floatRect = floatWin.get_frame_rect();
            // Covered = covering windows above this floater in Z together fully cover its width
            const covered = this._isFullyCovered(floatRect, coveringWins, floatIdx, sorted);
            LOG('  floater:', floatWin.get_wm_class(), `z=${floatIdx} covered=${covered}`);
            if (covered) coveredFloaters.push(floatWin);
        }

        if (coveredFloaters.length === 0) return;
        LOG('covered floaters:', coveredFloaters.map(w => w.get_wm_class()));

        const needNewWs = [];
        for (const floatWin of coveredFloaters) {
            const relocated = this._tryRelocateOnSameWs(floatWin, freeArea) ||
                              this._tryRelocateOnPrevWs(floatWin, wsIdx, mon);
            if (!relocated) needNewWs.push(floatWin);
        }

        if (needNewWs.length > 0)
            this._moveBatchToNewWorkspace(needNewWs);
    }

    /**
     * True if the union of coveringWins that are ABOVE floatZ in Z-order
     * fully covers the horizontal span of floatRect (and overlap vertically).
     * This prevents false positives when a floater only partially overlaps a tile.
     */
    _isFullyCovered(floatRect, coveringWins, floatZ, sorted) {
        const floatL = floatRect.x;
        const floatR = floatRect.x + floatRect.width;
        // Collect x-intervals of covering windows above the floater in Z that overlap vertically
        const intervals = [];
        for (const cw of coveringWins) {
            const cwIdx = sorted.indexOf(cw);
            if (cwIdx <= floatZ) continue;
            const cr = cw.get_frame_rect();
            if (cr.y + cr.height <= floatRect.y || cr.y >= floatRect.y + floatRect.height) continue;
            intervals.push([cr.x, cr.x + cr.width]);
        }
        if (intervals.length === 0) return false;
        intervals.sort((a, b) => a[0] - b[0]);
        // Check if intervals cover [floatL, floatR] without gaps
        let covered = floatL;
        for (const [s, e] of intervals) {
            if (s > covered) return false;  // gap before this interval
            covered = Math.max(covered, e);
            if (covered >= floatR) return true;
        }
        return false;
    }

    /** Returns the free rect on this key (area not occupied by covering windows), or null. */
    _getFreeArea(key, wa) {
        // fullscreen or maximized → no free area
        for (const [win, wi] of this._windows) {
            if (wi.layoutKey !== key) continue;
            if (win.fullscreen || wi.state === 'maximized') return null;
        }

        // Use _layouts.get directly — _getLayout would create a phantom empty entry
        // for workspaces not in our map, wrongly reporting the whole screen as free.
        const layout    = this._layouts.get(key);
        const leftTile  = layout?.left  ?? null;
        const rightTile = layout?.right ?? null;

        if (leftTile && rightTile) return null;  // both sides filled

        if (leftTile) {
            const r    = leftTile.get_frame_rect();
            const xEnd = r.x + r.width;
            return { x: xEnd, y: wa.y, width: (wa.x + wa.width) - xEnd, height: wa.height };
        }
        if (rightTile) {
            const r = rightTile.get_frame_rect();
            return { x: wa.x, y: wa.y, width: r.x - wa.x, height: wa.height };
        }
        return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
    }

    /** Try to move floatWin into the free area on its current workspace by shifting x. */
    _tryRelocateOnSameWs(floatWin, freeArea) {
        if (!freeArea || freeArea.width < 50) return false;
        const rect  = floatWin.get_frame_rect();
        if (rect.width > freeArea.width) return false;  // floater doesn't fit — don't claim success
        const newX  = freeArea.x + Math.floor((freeArea.width - rect.width) / 2);
        const clamp = Math.max(freeArea.x, Math.min(newX, freeArea.x + freeArea.width - rect.width));
        LOG('relocate same ws:', floatWin.get_wm_class(), `x: ${rect.x} → ${clamp}`);
        this._suppress.add(floatWin);
        floatWin.move_frame(true, clamp, rect.y);
        this._suppress.delete(floatWin);
        return true;
    }

    /** Try to move floatWin to the previous workspace into its free area. */
    _tryRelocateOnPrevWs(floatWin, wsIdx, mon) {
        if (wsIdx <= 0) return false;
        const prevWsIdx = wsIdx - 1;
        const prevKey   = `${prevWsIdx}:${mon}`;
        const prevWs    = global.workspace_manager.get_workspace_by_index(prevWsIdx);
        if (!prevWs) return false;

        // Get work area from a tracked window on prev ws
        let wa = null;
        for (const [w, wi] of this._windows) {
            if (wi.layoutKey === prevKey) { wa = w.get_work_area_for_monitor(mon); break; }
        }
        if (!wa) {
            const wins = prevWs.list_windows().filter(w => w.get_monitor() === mon);
            if (wins.length > 0) wa = wins[0].get_work_area_for_monitor(mon);
        }
        if (!wa) return false;

        const prevFree = this._getFreeArea(prevKey, wa);
        LOG('tryRelocatePrevWs:', floatWin.get_wm_class(),
            `prevKey=${prevKey} prevFree=${JSON.stringify(prevFree)}`);
        if (!prevFree || prevFree.width < 50) return false;

        const rect  = floatWin.get_frame_rect();
        if (rect.width > prevFree.width) return false;  // floater doesn't fit — try new ws instead
        const info  = this._windows.get(floatWin);
        if (!info) return false;

        const newX  = prevFree.x + Math.floor((prevFree.width - rect.width) / 2);
        const clamp = Math.max(prevFree.x, Math.min(newX, prevFree.x + prevFree.width - rect.width));
        LOG('relocate prev ws:', floatWin.get_wm_class(), `ws${wsIdx}→ws${prevWsIdx} x=${clamp}`);

        this._moving.add(floatWin);
        info.layoutKey = prevKey;
        floatWin.change_workspace_by_index(prevWsIdx, false);
        this._defer(() => {
            this._moving.delete(floatWin);
            if (!this._windows.has(floatWin)) return;
            this._suppress.add(floatWin);
            floatWin.move_frame(true, clamp, rect.y);
            this._suppress.delete(floatWin);
        });
        return true;
    }

    // ── Tile displacement & workspace collapsing ─────────────────────────────

    /** True if all windows on wsIdx:mon (excluding excludeWin) are tracked tiles (no floaters). */
    _wsIsClean(wsIdx, mon, excludeWin) {
        const ws = global.workspace_manager.get_workspace_by_index(wsIdx);
        if (!ws) return false;
        const wins = ws.list_windows().filter(w =>
            w.get_monitor() === mon &&
            !w.is_always_on_all_workspaces() &&
            !w.minimized &&
            this._isRelevant(w) &&
            w !== excludeWin
        );
        for (const w of wins) {
            const wi = this._windows.get(w);
            if (!wi) return false;  // untracked window on this workspace
            if (wi.state !== 'tiled-left' && wi.state !== 'tiled-right') return false;
        }
        return true;
    }

    /** True if tileWin (currently on side) can merge into targetWsIdx on the same side. */
    _canMergeInto(tileWin, side, targetWsIdx, mon) {
        const targetKey    = `${targetWsIdx}:${mon}`;
        const targetLayout = this._getLayout(targetKey);
        const other        = side === 'left' ? 'right' : 'left';

        // Target must have partner on other side and our side free
        if (!targetLayout[other]) return false;
        if (targetLayout[side])   return false;

        // Both workspaces must be clean
        const srcWsIdx = tileWin.get_workspace()?.index() ?? -1;
        if (!this._wsIsClean(srcWsIdx, mon, tileWin))   return false;
        if (!this._wsIsClean(targetWsIdx, mon, null))   return false;

        // Width compatibility: |tileW + partnerW − screenW| ≤ 30% of screenW
        const wa       = tileWin.get_work_area_for_monitor(mon);
        const tileW    = tileWin.get_frame_rect().width;
        const partnerW = targetLayout[other].get_frame_rect().width;
        if (Math.abs(tileW + partnerW - wa.width) > wa.width * MERGE_THRESHOLD) return false;

        return true;
    }

    /** Displace occupant from its tile slot: merge into ws+1 if possible, else new workspace. */
    _displaceTile(occupant, side, mon) {
        const info = this._windows.get(occupant);
        if (!info) return;

        const manager   = global.workspace_manager;
        const srcWsIdx  = occupant.get_workspace()?.index() ?? -1;
        const nextWsIdx = srcWsIdx + 1;

        if (nextWsIdx < manager.get_n_workspaces() &&
            this._canMergeInto(occupant, side, nextWsIdx, mon)) {

            const occupantW  = occupant.get_frame_rect().width;
            const nextKey    = `${nextWsIdx}:${mon}`;
            const nextLayout = this._getLayout(nextKey);
            const other      = side === 'left' ? 'right' : 'left';

            this._removeFromLayout(occupant);
            this._moving.add(occupant);
            info.state     = `tiled-${side}`;
            info.layoutKey = nextKey;
            occupant.change_workspace_by_index(nextWsIdx, false);
            nextLayout[side] = occupant;

            LOG('displaceTile: merging', occupant.get_wm_class(), `into ws${nextWsIdx} side=${side}`);
            this._defer(() => {
                this._moving.delete(occupant);
                if (!this._windows.has(occupant)) return;
                const wa       = occupant.get_work_area_for_monitor(mon);
                const partnerW = wa.width - occupantW;
                this._doTile(occupant, side, wa, occupantW);
                const partner = nextLayout[other];
                if (partner && this._windows.has(partner))
                    this._doTile(partner, other, wa, partnerW);
            });
        } else {
            // No merge — give occupant its own new workspace, tiling on same side
            LOG('displaceTile: new ws for', occupant.get_wm_class(), `side=${side}`);
            this._moveToNewWorkspace(occupant, side);
        }
    }

    /** After a tile closes on wsIdx:closedSide, try to pull the matching tile from ws+1. */
    _collapseIfPossible(wsIdx, closedSide, mon) {
        const manager   = global.workspace_manager;
        const nextWsIdx = wsIdx + 1;
        if (nextWsIdx >= manager.get_n_workspaces()) return;

        const key        = `${wsIdx}:${mon}`;
        const layout     = this._getLayout(key);
        const nextKey    = `${nextWsIdx}:${mon}`;
        const nextLayout = this._getLayout(nextKey);
        const other      = closedSide === 'left' ? 'right' : 'left';

        // Our side must still be free and next ws must have a tile on same side
        if (layout[closedSide]) return;
        const candidate = nextLayout[closedSide];
        if (!candidate)  return;
        // Don't pull candidate away from its companion on the source workspace
        if (nextLayout[other]) return;

        if (!this._canMergeInto(candidate, closedSide, wsIdx, mon)) return;

        const candidateInfo = this._windows.get(candidate);
        if (!candidateInfo) return;

        const candidateW = candidate.get_frame_rect().width;
        this._removeFromLayout(candidate);
        this._moving.add(candidate);
        candidateInfo.state    = `tiled-${closedSide}`;
        candidateInfo.layoutKey = key;
        candidate.change_workspace_by_index(wsIdx, false);
        layout[closedSide] = candidate;

        LOG('collapseIfPossible: pulling', candidate.get_wm_class(), `from ws${nextWsIdx} into ws${wsIdx}`);
        this._defer(() => {
            this._moving.delete(candidate);
            if (!this._windows.has(candidate)) return;
            const wa      = candidate.get_work_area_for_monitor(mon);
            const partner = layout[other];
            if (partner && this._windows.has(partner)) {
                const partnerW = partner.get_frame_rect().width;
                this._doTile(candidate, closedSide, wa, wa.width - partnerW);
                this._doTile(partner,   other,       wa, partnerW);
            } else {
                this._doTile(candidate, closedSide, wa, candidateW);
            }
        });
    }

    /** Move a batch of windows to a single newly-created workspace.
     *  If a workspace move is already in flight, defers until it completes. */
    _moveBatchToNewWorkspace(wins) {
        if (wins.length === 0) return;

        const manager    = global.workspace_manager;
        const currentIdx = manager.get_active_workspace_index();
        const newIdx     = currentIdx;  // insert LEFT of current workspace

        manager.append_new_workspace(false, global.get_current_time());
        manager.reorder_workspace(
            manager.get_workspace_by_index(manager.get_n_workspaces() - 1),
            newIdx
        );
        this._ourWorkspaces.add(manager.get_workspace_by_index(newIdx));
        this._rebuildLayouts();

        for (const win of wins) {
            if (!this._windows.has(win)) continue;
            const info = this._windows.get(win);
            const mon  = win.get_monitor();
            this._moving.add(win);
            win.change_workspace_by_index(newIdx, false);
            if (info) info.layoutKey = `${newIdx}:${mon}`;
        }

        // Don't activate — covered floaters fly away silently; user stays on current workspace.
        this._defer(() => {
            for (const win of wins) this._moving.delete(win);
        });
    }

    /** Move win to a new workspace to the right of current.
     *  tileOnArrive: 'left'|'right'|null — if set, tile on that side upon arrival
     *  instead of activating the new workspace. */
    _moveToNewWorkspace(win, tileOnArrive = null, direction = 'right') {
        // Serialise: if another move is in flight, queue and process after it completes
        if (this._moveInFlight) {
            LOG('moveToNewWorkspace: queued', win.get_wm_class());
            this._moveQueue.push({ win, tileOnArrive, direction });
            return;
        }
        this._moveInFlight = true;
        this._doMoveToNewWorkspace(win, tileOnArrive, direction);
    }

    _doMoveToNewWorkspace(win, tileOnArrive = null, direction = 'right') {
        LOG('moveToNewWorkspace:', win.get_wm_class(), tileOnArrive ? `tileOnArrive=${tileOnArrive}` : '', `dir=${direction}`);

        // Guard: sticky windows can't be moved — Mutter silently ignores the call,
        // leaving an orphan empty workspace. Skip them entirely.
        if (win.is_always_on_all_workspaces()) {
            LOG('moveToNewWorkspace: skipping sticky window', win.get_wm_class());
            this._finishMove(win);
            return;
        }

        const manager    = global.workspace_manager;
        const currentIdx = manager.get_active_workspace_index();
        const oldWs      = win.get_workspace();
        const monitor    = win.get_monitor();

        manager.append_new_workspace(false, global.get_current_time());
        // 'right': insert after current (window follows user); 'left': insert before current
        // (blocker eviction — user stays on the tile workspace, blocker goes left/behind).
        const newIdx = direction === 'left' ? currentIdx : currentIdx + 1;
        manager.reorder_workspace(
            manager.get_workspace_by_index(manager.get_n_workspaces() - 1),
            newIdx
        );
        // Remember this workspace as ours so _leaveIfEmpty can navigate back on close.
        this._ourWorkspaces.add(manager.get_workspace_by_index(newIdx));
        // Indices of all workspaces >= newIdx shifted — rebuild all layout keys
        this._rebuildLayouts();

        this._moving.add(win);
        win.change_workspace_by_index(newIdx, false);

        const info = this._windows.get(win);
        if (info) info.layoutKey = `${newIdx}:${monitor}`;

        // When tiling on arrival or evicting left, stay on current workspace.
        // Otherwise activate the new workspace so the user follows their window.
        if (!tileOnArrive && direction !== 'left') {
            const fullscreen = oldWs.list_windows()
                .some(w => w.fullscreen && w.get_monitor() === monitor && w !== win);
            if (!fullscreen)
                manager.get_workspace_by_index(newIdx).activate(global.get_current_time());
        }

        this._defer(() => {
            this._moving.delete(win);
            if (this._windows.has(win)) {
                const info = this._windows.get(win);
                if (tileOnArrive) {
                    this._tileWindow(win, tileOnArrive);
                } else if (win.fullscreen || (win.maximized_horizontally && win.maximized_vertically)) {
                    // Window arrived already maximized/fullscreen (e.g. tiled→maximize path).
                    // Just register the state — do NOT call _restoreInitialState which
                    // would run _doMaximize and clobber the saved preMaxState.
                    if (info.state !== 'maximized') info.state = 'maximized';
                } else {
                    this._restoreInitialState(win);
                }
            }
            this._finishMove(win);
        });
    }

    _finishMove(_win) {
        this._moveInFlight = false;
        if (this._moveQueue.length > 0) {
            const { win: next, tileOnArrive, direction } = this._moveQueue.shift();
            if (this._windows.has(next)) {
                this._moveInFlight = true;
                this._doMoveToNewWorkspace(next, tileOnArrive, direction);
            } else {
                this._finishMove(null);  // window closed while queued, skip to next
            }
        }
    }
}
