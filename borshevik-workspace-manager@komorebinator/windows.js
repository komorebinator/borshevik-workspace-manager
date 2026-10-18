/* windows.js — between Mutter's window and workspace signals and dispatch.
 *
 * Takes windows under management as they appear, follows what happens to them, drops the echoes
 * of the extension's own actions — a change that leaves a window as its record says it is — and
 * turns everything else into intents. Decides nothing about placement.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { LOG, name } from './log.js';

const BATCH_MS = 150;
const RESTACK_MS = 80;
const FIRST_FRAME_WAIT_MS = 500;

const sideOf = rec => (rec?.role === 'tiled-left' ? 'left' : rec?.role === 'tiled-right' ? 'right' : null);

export class WindowTracker {
    constructor({ registry, rules, executor, dispatch, settings, isDragging }) {
        this._registry = registry;
        this._rules = rules;
        this._executor = executor;
        this._dispatch = dispatch;
        this._settings = settings;
        this._isDragging = isDragging;
        this.android = null;   // set by the extension once android exists
        this._pendingBatch = new Set();
        this._batchTimer = null;
        this._restackTimer = null;
        this._connected = new Map();
        this._seen = new Map();          // the full/minimized state last acted on, per window
        this._handles = [];
        this._wsHandles = [];
    }

    enable() {
        const d = global.display, wm = global.workspace_manager;
        this._handles = [
            [d, d.connect('window-created', (_d, win) => this._onWindowCreated(win))],
            [d, d.connect('restacked', () => this._onRestacked())],
            [d, d.connect('workareas-changed', () => this._onWorkAreasChanged())],
            [wm, wm.connect('active-workspace-changed', () => this._onActiveWorkspaceChanged())],
            [wm, wm.connect('workspace-added', (_m, i) => this._watchWorkspace(wm.get_workspace_by_index(i)))],
        ];
        for (let i = 0; i < wm.get_n_workspaces(); i++) this._watchWorkspace(wm.get_workspace_by_index(i));
    }

    disable() {
        for (const [obj, id] of [...this._handles, ...this._wsHandles]) {
            try { obj.disconnect(id); } catch {}
        }
        this._handles = [];
        this._wsHandles = [];
        for (const [win, ids] of this._connected) {
            for (const id of ids) {
                try { win.disconnect(id); } catch {}
            }
        }
        this._connected.clear();
        if (this._batchTimer) GLib.source_remove(this._batchTimer);
        if (this._restackTimer) GLib.source_remove(this._restackTimer);
        this._batchTimer = this._restackTimer = null;
        this._pendingBatch.clear();
        this._seen.clear();
    }

    _watchWorkspace(ws) {
        this._wsHandles.push([ws, ws.connect('window-removed', (_ws, win) => this._onWindowRemoved(ws, win))]);
    }

    isRelevant(win) {
        return win.window_type === Meta.WindowType.NORMAL && !win.skip_taskbar && !win.is_on_all_workspaces();
    }

    _defer(fn) {
        global.compositor.get_laters().add(Meta.LaterType.IDLE, () => {
            try { fn(); } catch (e) { LOG('windows: deferred call failed', e.message, e.stack); }
            return false;
        });
    }

    // ── new windows ──────────────────────────────────────────────────────────

    _onWindowCreated(win) {
        LOG('windows: created', name(win), `type=${win.window_type}`);
        if (!this.isRelevant(win) || this._registry.get(win)) return;
        let decided = false;
        const decide = why => {
            if (decided) return;
            decided = true;
            if (this._registry.get(win) || this._registry.isIgnored(win) || !win.get_compositor_private()) return;
            LOG('windows: deciding on', name(win), 'at', why);
            // A Wayland client names its app id after its window is created: only now can a
            // rule or the Android test go by class.
            if (this._rules.isClosed(win)) {
                this.close(win);
                return;
            }
            if (this._rules.isIgnored(win)) {
                this.ignore(win);
                return;
            }
            if (this.android?.isAndroid(win)) {
                // never moved from first-frame, which is emitted while a frame is painted
                this._defer(() => {
                    if (win.get_compositor_private()) this.android.watch(win);
                });
                return;
            }
            this.register(win);
        };
        const attach = () => {
            const actor = win.get_compositor_private();
            if (!actor) return;
            const id = actor.connect('first-frame', () => {
                actor.disconnect(id);
                decide('first frame');
            });
            // A window opening on a workspace that is not shown draws no frame until it is: Chrome
            // restoring a session, the view gone with its first window. It is not left unmanaged.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, FIRST_FRAME_WAIT_MS, () => {
                if (!decided && win.get_compositor_private() && this.isRelevant(win)) decide('timeout');
                return GLib.SOURCE_REMOVE;
            });
        };
        if (win.get_compositor_private()) {
            attach();
        } else {
            const id = win.connect('notify::compositor-private', () => {
                win.disconnect(id);
                attach();
            });
        }
    }

    close(win) {
        LOG('windows: closed by a rule', name(win));
        this._defer(() => {
            // a real time: outside an event get_current_time() is 0, which Mutter refuses to ping with
            if (win.get_compositor_private()) win.delete(global.display.get_current_time_roundtrip());
        });
    }

    ignore(win) {
        LOG('windows: ignored', name(win));
        this._registry.ignore(win);
        this._connect(win);
        this._defer(() => this._rules.apply(win));
    }

    register(win, { batch = true } = {}) {
        const full = win.fullscreen || (win.maximized_horizontally && win.maximized_vertically);
        const r0 = win.get_frame_rect();
        LOG('windows: register', name(win), `ws=${win.get_workspace()?.index()} full=${full}`,
            `size=${r0.width}x${r0.height}`);
        const rec = this._registry.track(win, {
            role: full ? 'full' : 'floating',
            preFull: full ? 'floating' : null,
            floatRect: this._appFloatRect(win) ?? (full ? null : { x: r0.x, y: r0.y, width: r0.width, height: r0.height }),
            lastWs: win.get_workspace(),
            lastMonitor: win.get_monitor(),
            ownWsRule: this._rules.ownWorkspaceRule(win),
            // one waiting for its batch is placed by its own opened intent, and no other plan
            // may count it before that
            placed: !batch,
        });
        this._seen.set(win, { full, fullscreen: win.fullscreen, minimized: win.minimized });
        this._connect(win);
        this._defer(() => this._rules.apply(win));
        if (batch) {
            this._pendingBatch.add(win);
            this._batchTimer ??= GLib.timeout_add(GLib.PRIORITY_DEFAULT, BATCH_MS, () => {
                this._batchTimer = null;
                this._flushBatch();
                return GLib.SOURCE_REMOVE;
            });
        }
        return rec;
    }

    // Its app's remembered size, centred on the work area: an app may open at the size it was last
    // tiled at, and its own geometry is then no float size.
    _appFloatRect(win) {
        let size;
        try { size = JSON.parse(this._settings.get_string('float-sizes'))[win.get_wm_class()]; } catch { return null; }
        if (!size) return null;
        const wa = win.get_work_area_current_monitor();
        const width = Math.round(wa.width * size.wr), height = Math.round(wa.height * size.hr);
        return { x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height };
    }

    _connect(win) {
        if (this._connected.has(win)) return;
        this._connected.set(win, [
            win.connect('unmanaged', () => this._onUnmanaged(win)),
            win.connect('workspace-changed', () => this._onWorkspaceChanged(win)),
            win.connect('notify::maximized-horizontally', () => this._onMaximizeChange(win)),
            win.connect('notify::maximized-vertically', () => this._onMaximizeChange(win)),
            win.connect('notify::fullscreen', () => this._onMaximizeChange(win)),
            win.connect('notify::minimized', () => this._onMinimizedChange(win)),
        ]);
    }

    _flushBatch() {
        const wins = [...this._pendingBatch].filter(w => this._registry.get(w) && w.get_compositor_private());
        this._pendingBatch.clear();
        LOG('windows: batch of', wins.length);
        if (wins.length) this._dispatch({ type: 'opened', wins });
    }

    // ── what happens to them ─────────────────────────────────────────────────

    _onUnmanaged(win) {
        this._connected.delete(win);
        this._seen.delete(win);
        this._pendingBatch.delete(win);
        const rec = this._registry.get(win);
        this._registry.drop(win);
        if (!rec) return;
        LOG('windows: closed', name(win));
        this._dispatch({ type: 'closed', ws: rec.lastWs, slot: sideOf(rec) });
    }

    _onWorkspaceChanged(win) {
        const rec = this._registry.get(win);
        const ws = win.get_workspace();
        if (!rec || !ws) return;
        if (ws === rec.lastWs) return;   // the extension's own move, or another workspace's index shift
        if (this._isDragging(win)) {     // carried along by a drag; drag dispatches what it means
            rec.lastWs = ws;
            return;
        }
        const from = rec.lastWs;
        rec.lastWs = ws;
        rec.lastMonitor = win.get_monitor();
        LOG('windows: moved by the user', name(win), '→ ws', ws.index());
        this._dispatch({ type: 'userMoved', win, from });
    }

    _onMaximizeChange(win) {
        const rec = this._registry.get(win);
        if (!rec) return;
        const full = win.fullscreen || (win.maximized_horizontally && win.maximized_vertically);
        const seen = this._seen.get(win) ?? {};
        // logged even when it changes nothing here, so the logs show when a window was fullscreen
        if (seen.fullscreen !== win.fullscreen)
            LOG('windows:', win.fullscreen ? 'fullscreen' : 'left fullscreen', name(win));
        // both maximized-* notifies fire for one operation: act on the combined state, once
        this._seen.set(win, { ...seen, full, fullscreen: win.fullscreen });
        if (seen.full === full) return;
        if (full === (rec.role === 'full')) return;   // the echo of the extension's own change
        if (!full && this._isDragging(win)) return;   // Mutter unmaximizes a dragged window; drag decides
        LOG('windows:', full ? 'made full' : 'no longer full', name(win));
        this._dispatch({ type: full ? 'full' : 'unfull', win });
    }

    _onMinimizedChange(win) {
        const rec = this._registry.get(win);
        if (!rec) return;
        const seen = this._seen.get(win) ?? {};
        if (seen.minimized === win.minimized) return;
        this._seen.set(win, { ...seen, minimized: win.minimized });
        LOG('windows:', win.minimized ? 'minimized' : 'restored', name(win));
        this._dispatch({ type: win.minimized ? 'minimized' : 'restored', win });
    }

    _onWindowRemoved(ws, win) {
        if (this._executor.isMoving(win)) return;
        // closed or moved elsewhere is known only once unmanaging has finished
        this._defer(() => {
            if (this.android?.wasClosed(win)) this.android.awaitReplacement(ws, win);
            else this._leaveIfEmpty(ws);
        });
    }

    _leaveIfEmpty(ws) {
        const action = this._settings.get_string('on-empty-workspace');
        if (action === 'nothing') return;
        const manager = global.workspace_manager;
        const i = ws.index();
        if (i < 0 || manager.get_active_workspace() !== ws) return;
        const holds = w => !w.is_on_all_workspaces() && this.isRelevant(w);
        if (ws.list_windows().some(holds)) return;
        LOG('windows: active ws', i, 'emptied by the user —', action);
        if (action === 'overview') {
            if (!Main.overview.visible) Main.overview.show();
            return;
        }
        let target = manager.get_workspace_by_index(i - 1);
        if (!target) {
            const right = manager.get_workspace_by_index(i + 1);
            if (!right || !right.list_windows().some(holds)) return;
            target = right;
        }
        target.activate(global.get_current_time());
    }

    _onActiveWorkspaceChanged() {
        if (!this._settings.get_boolean('overview-on-last-workspace') || Main.overview.visible) return;
        const manager = global.workspace_manager;
        if (manager.get_active_workspace_index() !== manager.get_n_workspaces() - 1) return;
        const ws = manager.get_active_workspace();
        if (!ws.list_windows().some(w => !w.is_on_all_workspaces() && this.isRelevant(w))) Main.overview.show();
    }

    _onRestacked() {
        if (this._restackTimer) return;
        this._restackTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTACK_MS, () => {
            this._restackTimer = null;
            const ws = global.workspace_manager.get_active_workspace();
            if (this._registry.windows().some(w => w.get_workspace() === ws))
                this._dispatch({ type: 'recheck', ws });
            return GLib.SOURCE_REMOVE;
        });
    }

    _onWorkAreasChanged() {
        const manager = global.workspace_manager;
        for (let i = 0; i < manager.get_n_workspaces(); i++)
            this._dispatch({ type: 'recheck', ws: manager.get_workspace_by_index(i), relayout: true });
    }

    // After a shell restart some windows — Chrome web apps among them — come back without the
    // signals new windows send; they are taken where they are, without moving them.
    adoptExisting() {
        const manager = global.workspace_manager;
        for (let i = 0; i < manager.get_n_workspaces(); i++) {
            for (const win of manager.get_workspace_by_index(i).list_windows()) {
                if (!this.isRelevant(win) || this._registry.get(win) || this._registry.isIgnored(win)) continue;
                if (this._rules.isClosed(win)) {
                    this.close(win);
                    continue;
                }
                if (this._rules.isIgnored(win)) {
                    this.ignore(win);
                    continue;
                }
                if (this.android?.isAndroid(win)) {
                    this.android.adoptExisting(win);
                    continue;
                }
                this.register(win, { batch: false });
                LOG('windows: adopted', name(win), '→', this._registry.get(win).role);
            }
        }
    }
}
