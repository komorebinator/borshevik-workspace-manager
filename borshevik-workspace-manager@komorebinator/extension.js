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

export default class BorshevikWorkspaceManager extends Extension {

    // ── Lifecycle ────────────────────────────────────────────────────────────

    enable() {
        this._settings = this.getSettings();

        const updateLog = () => {
            LOG = this._settings.get_boolean('debug-logging')
                ? (...a) => console.log('[BWM]', ...a) : () => {};
        };
        updateLog();
        this._moveWhenMax = this._settings.get_boolean('move-window-when-maximized');

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

        // Windows that have already been through _handleNewWindow or _restoreInitialState.
        // Used to count "settled" windows when deciding placement for new arrivals — avoids
        // treating all simultaneously-mapped windows as "existing content".
        this._handled = new Set();

        // Batch processing for auto-tile: collect windows that map within a short window
        // (~150 ms) and process them together. This ensures Chrome "restore windows" and
        // similar multi-window sessions are seen as a batch, with each window's final
        // size/state already applied before we decide on placement.
        this._pendingBatch = new Set();
        this._batchTimer   = null;

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

        this._preview.destroy();
        this._preview = null;

        this._mutterSettings.set_boolean('edge-tiling', this._savedEdgeTiling);
        this._mutterSettings = null;

        this._windows.clear(); this._windows = null;
        this._layouts.clear(); this._layouts = null;
        this._handled.clear(); this._handled = null;
        this._ourWorkspaces.clear(); this._ourWorkspaces = null;
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

        LOG('map:', win.get_wm_class(), `ws=${win.get_workspace().index()} mon=${win.get_monitor()}`);

        const info = {
            state:           'floating',
            preMaxState:     null,
            floatRect:       this._toRect(win.get_frame_rect()),
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
        LOG(`flushBatch: ${wins.length} window(s)`);
        for (const win of wins) {
            if (this._windows.has(win))
                this._handleNewWindow(win);
        }
    }

    _onUnmanaged(win) {
        LOG('unmanaged:', win.get_wm_class());
        // Capture workspace object now, before we delete the window from our map.
        const layoutKey = this._windows.get(win)?.layoutKey;
        const ws = layoutKey
            ? global.workspace_manager.get_workspace_by_index(parseInt(layoutKey.split(':')[0]))
            : null;
        this._removeFromLayout(win);
        this._windows.delete(win);
        this._handled.delete(win);
        this._pendingBatch.delete(win);
        if (ws)
            this._defer(() => this._leaveIfEmpty(ws));
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
        // User manually moved the window — respect their choice, only tile if a slot is free.
        // Never force-move to a new workspace.
        if (this._moveWhenMax)
            this._defer(() => this._tileIntoFreeSlot(win));
    }

    _onMaximizeChange(win) {
        if (this._suppress.has(win)) return;
        const info = this._windows.get(win);
        if (!info) return;

        const full = win.maximized_horizontally && win.maximized_vertically;

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
                info.state    = prev;
                layout[side]  = win;
                this._defer(() => this._doTile(win, side));
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
            this._drag = { win, monitor: win.get_monitor(), startX, startY };

            const info = this._windows.get(win);

            // If tiled — immediately restore float size so window shrinks while dragging,
            // not after drop. Keep top-left in place so Mutter's drag offset stays correct.
            if ((info?.state === 'tiled-left' || info?.state === 'tiled-right') && info.floatRect) {
                LOG('drag-begin: restore float size immediately', info.floatRect.width, 'x', info.floatRect.height);
                this._removeFromLayout(win);
                info.state = 'floating';
                const cur = win.get_frame_rect();
                this._suppress.add(win);
                win.move_resize_frame(false, cur.x, cur.y, info.floatRect.width, info.floatRect.height);
                this._suppress.delete(win);
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
            // If window was tiled, untile it — restore to floating size at current position
            if (info.state === 'tiled-left' || info.state === 'tiled-right') {
                LOG('drag-end: untile', win.get_wm_class(), 'restoring floatRect');
                this._removeFromLayout(win);
                info.state = 'floating';
                // Restore original floating size but keep current position (where user dropped it)
                if (info.floatRect) {
                    const cur = win.get_frame_rect();
                    this._suppress.add(win);
                    win.move_resize_frame(false, cur.x, cur.y, info.floatRect.width, info.floatRect.height);
                    this._suppress.delete(win);
                }
            }
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
        if (this._snapSide === 'maximize')
            this._doMaximize(win);
        else
            this._tileWindow(win, this._snapSide);
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

    /** Tile win to side, swapping the current occupant if the side is taken. */
    _tileWindow(win, side) {
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
                // Both sides occupied — send to new workspace instead of corrupting layout
                this._moveToNewWorkspace(win);
                return;
            }
            // Swap: push occupant to the other side.
            // Set state BEFORE _doTile so the applyGeometry guard inside sees 'tiled-*'.
            const oi = this._windows.get(occupant);
            if (oi) oi.state = `tiled-${other}`;
            layout[other] = occupant;
            this._doTile(occupant, other, wa);
        }

        if (info.state === 'floating')
            info.floatRect = this._toRect(win.get_frame_rect());

        // Set state BEFORE _doTile so the applyGeometry guard inside sees 'tiled-*'.
        info.state   = `tiled-${side}`;
        layout[side] = win;
        this._doTile(win, side, wa);
        LOG('tile:', win.get_wm_class(), '→', side);
    }

    /** Raw geometry tile — no state or layout updates. */
    _doTile(win, side, wa = null) {
        if (!wa) wa = win.get_work_area_current_monitor();
        const half = Math.floor(wa.width / 2);
        const x    = side === 'left' ? wa.x : wa.x + half;
        const w    = side === 'left' ? half : wa.width - half;

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

        // Check whether any other window on this ws:monitor was already handled (placed).
        // We use _handled (not ws.list_windows()) so simultaneously-mapped windows
        // don't incorrectly see each other as "existing content" before any have been placed.
        let hasExistingHandled = false;
        for (const [w, wi] of this._windows) {
            if (w === win) continue;
            if (!this._handled.has(w)) continue;
            if (wi.layoutKey !== info.layoutKey) continue;
            hasExistingHandled = true;
            break;
        }

        const winIsBlocking = win.fullscreen ||
            (win.maximized_horizontally && win.maximized_vertically) ||
            info.state === 'maximized';

        const hasBlocker = this._hasBlockingWindow(info.layoutKey, win);
        const slotsUsed  = (layout.left ? 1 : 0) + (layout.right ? 1 : 0);

        LOG('handleNewWindow:', win.get_wm_class(), `key=${info.layoutKey}`,
            `left=${layout.left?.get_wm_class() ?? '-'} right=${layout.right?.get_wm_class() ?? '-'}`,
            `existing=${hasExistingHandled} slots=${slotsUsed} blocking=${winIsBlocking}`);

        // Blocking conditions → send to new workspace.
        if (hasBlocker || slotsUsed >= 2 || (winIsBlocking && hasExistingHandled)) {
            this._moveToNewWorkspace(win);
            return;
        }

        // One tiled slot taken → fill the other
        if (layout.left || layout.right) {
            this._tileWindow(win, layout.left ? 'right' : 'left');
            return;
        }

        // No tiled windows and no reason to move — just place based on geometry
        this._restoreInitialState(win);
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

    /** Returns true if there's a fullscreen or maximized window on this ws:monitor (excluding win itself). */
    _hasBlockingWindow(layoutKey, excludeWin) {
        const [wsIdxStr, monIdxStr] = layoutKey.split(':');
        const wsIdx  = parseInt(wsIdxStr);
        const monIdx = parseInt(monIdxStr);
        const ws = global.workspace_manager.get_workspace_by_index(wsIdx);
        if (!ws) return false;
        return ws.list_windows().some(w => {
            if (w === excludeWin) return false;
            if (!this._isRelevant(w)) return false;
            if (w.get_monitor() !== monIdx) return false;
            if (w.is_always_on_all_workspaces()) return false;
            if (w.fullscreen) return true;
            const info = this._windows.get(w);
            return info?.state === 'maximized';
        });
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
        } else if (hr > 0.9 && wr >= 0.4 && wr <= 0.6) {
            this._tileWindow(win, 'left');
        }
        // otherwise leave floating
    }

    _moveToNewWorkspace(win) {
        // Serialise: if another move is in flight, queue and process after it completes
        if (this._moveInFlight) {
            LOG('moveToNewWorkspace: queued', win.get_wm_class());
            this._moveQueue.push(win);
            return;
        }
        this._moveInFlight = true;
        this._doMoveToNewWorkspace(win);
    }

    _doMoveToNewWorkspace(win) {
        LOG('moveToNewWorkspace:', win.get_wm_class());

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
        const newIdx = currentIdx + 1;
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

        const fullscreen = oldWs.list_windows()
            .some(w => w.fullscreen && w.get_monitor() === monitor && w !== win);
        if (!fullscreen)
            manager.get_workspace_by_index(newIdx).activate(global.get_current_time());

        this._defer(() => {
            this._moving.delete(win);
            if (this._windows.has(win)) {
                const info = this._windows.get(win);
                if (win.maximized_horizontally && win.maximized_vertically) {
                    // Window arrived already maximized (e.g. tiled→maximize path).
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
            const next = this._moveQueue.shift();
            if (this._windows.has(next)) {
                this._moveInFlight = true;
                this._doMoveToNewWorkspace(next);
            } else {
                this._finishMove(null);  // window closed while queued, skip to next
            }
        }
    }
}
