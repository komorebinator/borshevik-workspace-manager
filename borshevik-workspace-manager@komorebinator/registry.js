/* registry.js — what the extension knows about each window it manages.
 *
 * A window is managed exactly when it has a record. Owned by the extension and cleared on
 * disable; nothing is attached to Meta.Window objects.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export class Registry {
    constructor() {
        this._records = new Map();
        this._ignored = new Set();
    }

    get(win) {
        return this._records.get(win);
    }

    track(win, fields = {}) {
        this._ignored.delete(win);
        const record = {
            role: 'floating', preFull: null, home: null, floatRect: null, minimizedFrom: null,
            lastWs: null, lastMonitor: -1, tileRect: null, placed: true, rules: new Set(), ownWsRule: null, pendingRect: null,
            ...fields,
        };
        this._records.set(win, record);
        return record;
    }

    forget(win) {
        this._records.delete(win);
    }

    ignore(win) {
        this._records.delete(win);
        this._ignored.add(win);
    }

    isIgnored(win) {
        return this._ignored.has(win);
    }

    // A closed window is neither managed nor ignored any more.
    drop(win) {
        this._records.delete(win);
        this._ignored.delete(win);
    }

    windows() {
        return [...this._records.keys()];
    }

    clear() {
        this._records.clear();
        this._ignored.clear();
    }
}
