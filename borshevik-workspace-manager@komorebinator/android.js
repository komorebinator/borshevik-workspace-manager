/* android.js — Waydroid's windows.
 *
 * Every Waydroid window is a maximized surface the size of Android's whole display; the app is
 * drawn on subsurfaces inside it, where Android put it. Only those layers tell a full-screen app
 * from a floating one: the first is registered as a full window like any other, the second is
 * left alone, and a window Waydroid replaces keeps its place. What this moves it moves through
 * dispatch, like everything else.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import { LOG, name } from './log.js';

export const ANDROID_CLASS = /^(Waydroid|waydroid[.].+)$/;
export const ANDROID_REPLACE_MS = 500;

export class AndroidWindows {
    constructor({ registry, windows, rules, dispatch }) {
        this._registry = registry;
        this._windows = windows;
        this._rules = rules;
        this._dispatch = dispatch;
        this._state = new Map();
        this._followed = new WeakSet();
        this._gone = [];
    }

    disable() {
        for (const [win, st] of this._state) {
            this._unfollow(win);
            this._cancelRelease(win);
            if (st.unmanagedId) {
                try { win.disconnect(st.unmanagedId); } catch {}
            }
        }
        this._state.clear();
        this._state = null;
        for (const g of this._gone) GLib.source_remove(g.timer);
        this._gone = [];
    }

    isAndroid(win) {
        return ANDROID_CLASS.test(win.get_wm_class() ?? '');
    }

    isFullScreen(win) {
        return !!this._state?.get(win)?.fullScreen;
    }

    wasClosed(win) {
        return !!this._closed?.has(win);
    }

    // true: the app's layers cover the window; false: they cover less; null: none attached yet.
    _fillsWindow(win) {
        const actor = win.get_compositor_private();
        if (!actor) return null;
        const surfaceType = GObject.type_from_name('MetaSurfaceActor');
        const surfaces = [];
        const walk = a => {
            for (const c of a.get_children()) {
                if (GObject.type_is_a(c.constructor.$gtype, surfaceType)) surfaces.push(c);
                walk(c);
            }
        };
        walk(actor);
        const [background, ...rest] = surfaces;
        const layers = rest.filter(s => s.visible && s.width > 1 && s.height > 1);
        if (!background || !layers.length) return null;
        const x1 = Math.min(...layers.map(s => s.x));
        const y1 = Math.min(...layers.map(s => s.y));
        const x2 = Math.max(...layers.map(s => s.x + s.width));
        const y2 = Math.max(...layers.map(s => s.y + s.height));
        return x1 <= 2 && y1 <= 2 && x2 >= background.width - 2 && y2 >= background.height - 2;
    }

    watch(win, { adopt = false } = {}) {
        if (!this._state || this._state.has(win)) return;
        const st = { fullScreen: false, handlers: [], pending: false, release: null, inheritedOrigin: null, adopt };
        this._state.set(win, st);
        if (!adopt) this.claimPlace(win);
        // before windows#_onUnmanaged, which drops the record the origin is read from
        st.unmanagedId = win.connect('unmanaged', () => {
            st.handlers = [];   // its actors went with it, and their handlers with them
            this._cancelRelease(win);
            (this._closed ??= new WeakSet()).add(win);
            const origin = st.fullScreen ? this._origin(win) : null;
            this._goneOrigins ??= new WeakMap();
            this._goneOrigins.set(win, origin);
            this._state?.delete(win);
        });
        this._follow(win, win.get_compositor_private());
        this._check(win);
        st.adopt = false;
    }

    _follow(win, actor) {
        if (!actor || this._followed.has(actor)) return;
        this._followed.add(actor);
        const st = this._state.get(win);
        const changed = () => this._scheduleCheck(win);
        st.handlers.push([actor, actor.connect('child-added', (_a, child) => {
            this._follow(win, child);
            changed();
        })]);
        st.handlers.push([actor, actor.connect('child-removed', changed)]);
        if (GObject.type_is_a(actor.constructor.$gtype, GObject.type_from_name('MetaSurfaceActor'))) {
            st.handlers.push([actor, actor.connect('notify::allocation', changed)]);
            st.handlers.push([actor, actor.connect('notify::visible', changed)]);
        }
        for (const child of actor.get_children()) this._follow(win, child);
    }

    _unfollow(win) {
        const st = this._state?.get(win);
        for (const [obj, id] of st?.handlers ?? []) {
            obj.disconnect(id);
            this._followed.delete(obj);
        }
        if (st) st.handlers = [];
    }

    _scheduleCheck(win) {
        const st = this._state?.get(win);
        if (!st || st.pending) return;
        st.pending = true;
        global.compositor.get_laters().add(Meta.LaterType.IDLE, () => {
            st.pending = false;
            if (this._state?.has(win)) this._check(win);
            return false;
        });
    }

    _check(win) {
        if (!win.get_compositor_private()) return;
        const st = this._state.get(win);
        const fills = this._fillsWindow(win);
        if (st.fullScreen) {
            if (fills === false) this._scheduleRelease(win);
            else if (fills === true) this._cancelRelease(win);
        } else if (fills === true) {
            this._takeFullScreen(win);
        } else if (!this._registry.isIgnored(win)) {
            // new, with its app's layers not filling it or not there yet: left alone until they do
            LOG('android:', fills === null ? 'no layers yet' : 'floating', name(win));
            this._windows.ignore(win);
            if (fills === false) this._return(win, st.inheritedOrigin);
        } else if (fills === false && st.inheritedOrigin) {
            this._return(win, st.inheritedOrigin);
        }
    }

    _takeFullScreen(win) {
        LOG('android: full screen', name(win));
        const st = this._state.get(win);
        st.fullScreen = true;
        // adopted at enable, it is taken where it is; new, it is placed like any new window
        this._windows.register(win, { batch: !st.adopt });
    }

    _scheduleRelease(win) {
        const st = this._state.get(win);
        if (st.release) return;
        st.release = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANDROID_REPLACE_MS, () => {
            st.release = null;
            if (st.fullScreen && this._state?.has(win) && this._fillsWindow(win) === false) this._release(win);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelRelease(win) {
        const st = this._state?.get(win);
        if (!st?.release) return;
        GLib.source_remove(st.release);
        st.release = null;
    }

    _release(win) {
        const origin = this._origin(win);
        LOG('android: floating again', name(win), 'origin=', origin?.index() ?? 'none');
        this._state.get(win).fullScreen = false;
        this._registry.forget(win);
        this._windows.ignore(win);
        this._return(win, origin);
    }

    _origin(win) {
        const st = this._state?.get(win);
        return st?.inheritedOrigin ?? this._registry.get(win)?.home?.ws ?? null;
    }

    _return(win, origin) {
        const st = this._state?.get(win);
        if (st) st.inheritedOrigin = null;
        if (!origin || origin.index() < 0 || origin === win.get_workspace()) return;
        this._dispatch({ type: 'returnTo', win, ws: origin, show: true });
    }

    // ── replacement ──────────────────────────────────────────────────────────

    awaitReplacement(ws, win) {
        const gone = { cls: win.get_wm_class(), ws, origin: this._goneOrigins?.get(win) ?? null };
        LOG('android: closed', gone.cls, 'on ws', ws.index(), '— awaiting a replacement');
        gone.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANDROID_REPLACE_MS, () => {
            this._gone.splice(this._gone.indexOf(gone), 1);
            this._windows._leaveIfEmpty(ws);
            return GLib.SOURCE_REMOVE;
        });
        this._gone.push(gone);
    }

    claimPlace(win) {
        const i = this._gone.findIndex(g => g.cls === win.get_wm_class());
        if (i < 0) return;
        const [gone] = this._gone.splice(i, 1);
        GLib.source_remove(gone.timer);
        LOG('android: replaces a closed window', gone.cls, 'ws', gone.ws.index());
        if (gone.origin) this._state.get(win).inheritedOrigin = gone.origin;
        if (gone.ws.index() >= 0 && win.get_workspace() !== gone.ws)
            this._dispatch({ type: 'returnTo', win, ws: gone.ws, show: false });
    }

    // At enable: watched first, so its unmanaged handler comes before the record's; a full-screen
    // one is then registered where it is, a floating one left alone.
    adoptExisting(win) {
        if (!this._fillsWindow(win)) this._windows.ignore(win);
        this.watch(win, { adopt: true });
    }
}
