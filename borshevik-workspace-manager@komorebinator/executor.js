/* executor.js — carries out a planner plan through Mutter.
 *
 * Before each operation that changes a window it writes the outcome into the window's record —
 * its role, the workspace it will be on — so the signals Mutter sends back match the record and
 * are recognised as echoes by the adapters (see the guidelines).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import GLib from 'gi://GLib';
import { LOG, name } from './log.js';

// How long a window is watched after it is given a geometry: for Chrome putting its old position
// back after an unmaximize, and for a window that settles wider than asked
const WATCH_MS = 2000;

export class Executor {
    constructor({ registry, settings, onSettled }) {
        this._registry = registry;
        this._settings = settings;
        this._onSettled = onSettled;
        this._running = false;
        this._moving = new Set();
        this._wasFull = new WeakSet();   // windows just brought out of maximize or fullscreen
        this._timers = new Set();
        this._handlers = [];
    }

    get running() { return this._running; }

    // A window the executor is moving right now: window-removed fires inside change_workspace.
    isMoving(win) {
        return this._moving.has(win);
    }

    destroy() {
        for (const id of this._timers) GLib.source_remove(id);
        this._timers.clear();
        for (const [obj, id] of this._handlers) {
            try { obj.disconnect(id); } catch {}
        }
        this._handlers = [];
    }

    _timeout(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return id;
    }

    run(plan, done) {
        this._running = true;
        const refs = new Map();
        const wm = global.workspace_manager;
        let waiting = 0;
        let finished = false;
        const finish = () => {
            if (finished || waiting > 0) return;
            finished = true;
            this._running = false;
            done?.();
        };
        const wait = () => {
            waiting++;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                waiting--;
                finish();
            };
        };

        LOG('executor: run', plan.ops.length, 'op(s)', plan.activate ? 'and show a workspace' : '');
        for (const op of plan.ops) {
            try {
                this._apply(op, refs, wait);
            } catch (e) {
                LOG('executor: op failed', op.op, e.message, e.stack);
            }
        }

        try {
            // whether to show anything is the planner's (behaviour#view-follows-user)
            const target = this._resolve(plan.activate, refs);
            if (target && target.index() >= 0 && target !== wm.get_active_workspace()) {
                const focus = plan.focus;
                if (focus && focus.get_workspace() === target && !focus.minimized) {
                    // with the focus: when focus follows the mouse, GNOME would give it to
                    // whatever is under the pointer
                    LOG('executor: show ws', target.index(), 'focusing', name(focus));
                    target.activate_with_focus(focus, global.get_current_time());
                } else {
                    LOG('executor: show ws', target.index());
                    target.activate(global.get_current_time());
                }
            }
        } catch (e) {
            LOG('executor: activate failed', e.message);
        }
        finish();
    }

    _resolve(ws, refs) {
        if (!ws) return null;
        return ws.newWorkspace ? refs.get(ws.newWorkspace) ?? null : ws;
    }

    _apply(op, refs, wait) {
        const win = op.win;
        const rec = win ? this._registry.get(win) : null;
        switch (op.op) {
        case 'newWorkspace': this._newWorkspace(op, refs); break;
        case 'move': {
            const ws = this._resolve(op.ws, refs);
            if (!ws) throw new Error('move to an unknown workspace');
            this._move(win, ws, rec);
            break;
        }
        case 'tile':
            if (rec) {
                rec.role = `tiled-${op.side}`;
                rec.tileRect = { ...op.rect };
            }
            this._unfull(win);
            this._applyGeometry(win, op.rect, rec, wait, true);
            break;
        case 'full':
            if (rec) {
                rec.role = 'full';
                if (op.preFull !== undefined) rec.preFull = op.preFull;
            }
            if (!win.fullscreen && !(win.maximized_horizontally && win.maximized_vertically))
                win.maximize();
            break;
        case 'float':
            if (rec) rec.role = 'floating';
            this._float(win, op, rec, wait);
            break;
        case 'place': win.move_frame(true, op.x, op.y); break;
        case 'home': if (rec) rec.home = op.home && { ...op.home, ws: this._resolve(op.home.ws, refs) }; break;
        case 'floatRect': if (rec) rec.floatRect = { ...op.rect }; break;
        case 'floatSize': this._rememberFloatSize(win, op.rect, rec); break;
        case 'minimizedFrom': if (rec) rec.minimizedFrom = op.value; break;
        case 'raise': this._restack(win, true); break;
        case 'lower': this._restack(win, false); break;
        default: throw new Error(`unknown op ${op.op}`);
        }
    }

    // Appended, then moved into place; the window meant for it moves there in the same run, before
    // anything idles, so GNOME never sees the new workspace empty.
    _newWorkspace(op, refs) {
        const wm = global.workspace_manager;
        const anchor = this._resolve(op.before ?? op.after, refs);
        wm.append_new_workspace(false, global.get_current_time());
        const ws = wm.get_workspace_by_index(wm.get_n_workspaces() - 1);
        const at = op.before ? anchor.index() : anchor.index() + 1;
        wm.reorder_workspace(ws, at);
        refs.set(op.ref.newWorkspace, ws);
        LOG('executor: new ws at', at);
    }

    _move(win, ws, rec) {
        if (win.is_on_all_workspaces()) return;
        if (rec) rec.lastWs = ws;
        this._moving.add(win);
        try {
            win.change_workspace(ws);
        } finally {
            this._moving.delete(win);
        }
        LOG('executor: move', name(win), '→ ws', ws.index());
    }

    _unfull(win) {
        if (!win.fullscreen && !win.maximized_horizontally && !win.maximized_vertically) return;
        if (win.fullscreen) win.unmake_fullscreen();
        if (win.maximized_horizontally || win.maximized_vertically) win.unmaximize();
        this._wasFull.add(win);
    }

    // Move, then resize: some apps ignore the move half of a combined call. After an unmaximize
    // Chrome restores its old position once the new geometry is in, so the rect goes in once more
    // on the next size-changed. Once settled, a window wider than asked reports its width.
    _applyGeometry(win, rect, rec, wait, isTile) {
        const role = rec?.role;
        const apply = () => {
            if (rec && rec.role !== role) return;
            win.move_frame(true, rect.x, rect.y);
            win.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
        };
        const wasFull = this._wasFull.has(win);
        this._wasFull.delete(win);
        apply();
        if (wasFull) {
            const release = wait();
            let id = win.connect('size-changed', () => {
                win.disconnect(id);
                id = null;
                apply();
                release();
            });
            this._timeout(WATCH_MS, () => {
                if (id !== null) { win.disconnect(id); id = null; }
                release();
            });
        }
        if (isTile) {
            // a window with a smallest width ends up wider than asked — at once, or once a slow
            // app has caught up: whenever its size changes while it is watched, not after a guess
            let id = win.connect('size-changed', () => {
                if (rec && rec.role !== role) return;
                const now = win.get_frame_rect();
                if (now.width > rect.width + 4) {
                    win.disconnect(id);
                    id = null;
                    LOG('executor: settled wider', name(win), now.width, '>', rect.width);
                    this._onSettled(win, now.width);
                }
            });
            this._timeout(WATCH_MS, () => {
                if (id !== null) { win.disconnect(id); id = null; }
            });
        }
    }

    _float(win, op, rec, wait) {
        this._unfull(win);
        if (op.rect) {
            const rect = op.keepPosition ? { ...op.rect, ...this._position(win) } : op.rect;
            this._applyGeometry(win, rect, rec, wait, false);
            return;
        }
        this._wasFull.delete(win);
        // no geometry known — a window that opened maximized: centred at the size it settles at
        const release = wait();
        let id = win.connect('size-changed', () => {
            win.disconnect(id);
            id = null;
            const wa = win.get_work_area_current_monitor();
            const r = win.get_frame_rect();
            const x = wa.x + Math.round((wa.width - r.width) / 2);
            const y = wa.y + Math.round((wa.height - r.height) / 2);
            win.move_frame(true, x, y);
            if (rec) rec.floatRect = { x, y, width: r.width, height: r.height };
            release();
        });
        this._timeout(WATCH_MS, () => {
            if (id !== null) { win.disconnect(id); id = null; }
            release();
        });
    }

    _position(win) {
        const r = win.get_frame_rect();
        return { x: r.x, y: r.y };
    }

    _rememberFloatSize(win, rect, rec) {
        if (rec) rec.floatRect = { ...rect };
        const wa = win.get_work_area_current_monitor();
        try {
            const map = JSON.parse(this._settings.get_string('float-sizes'));
            map[win.get_wm_class()] = { wr: rect.width / wa.width, hr: rect.height / wa.height };
            this._settings.set_string('float-sizes', JSON.stringify(map));
        } catch (e) {
            LOG('executor: float-sizes unreadable', e.message);
        }
    }

    _restack(win, up) {
        if (up) win.raise();
        else win.lower();
    }
}
