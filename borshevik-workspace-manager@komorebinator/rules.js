/* rules.js — window rules: matching windows against them and applying their actions.
 *
 * The rules are the window-rules setting, in the shape rules-ui writes. Opening on a workspace
 * of its own is a placement, which the planner decides; this only says which rule asks for it.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LOG, name } from './log.js';

const PATTERNS = ['class', 'title'];

// Whether a rule picks some windows rather than all: one of its conditions is on and narrows —
// a pattern that is not empty, or a flag (on every workspace, above, ...). An empty pattern
// matches every class and title, so a rule whose only condition is one would apply to every
// window there is.
export function narrows(rule) {
    return Object.entries(rule.conditions ?? {}).some(([key, c]) =>
        c?.enabled && (!PATTERNS.includes(key) || (c.regex ?? '') !== ''));
}

// Whether a rule can be saved: it narrows, and every pattern it has on is one; a pattern that is
// not would match no window at all.
export function savable(rule) {
    if (!narrows(rule)) return false;
    return PATTERNS.every(key => {
        const c = rule.conditions?.[key];
        if (!c?.enabled) return true;
        try { new RegExp(c.regex ?? ''); return true; } catch { return false; }
    });
}

export class WindowRules {
    constructor({ settings, registry }) {
        this._settings = settings;
        this._registry = registry;
    }

    _rules() {
        try {
            return JSON.parse(this._settings.get_string('window-rules'));
        } catch {
            return [];
        }
    }

    apply(win) {
        const rec = this._registry.get(win);
        if (rec) rec.rules = new Set();
        for (const rule of this._rules()) this._applyOne(win, rule);
    }

    applyToAll(rule) {
        const manager = global.workspace_manager;
        for (let i = 0; i < manager.get_n_workspaces(); i++) {
            for (const win of manager.get_workspace_by_index(i).list_windows()) {
                if (this._registry.get(win) || this._registry.isIgnored(win)) this._applyOne(win, rule);
            }
        }
    }

    // Asked only before a window is first taken under management; a managed window stays managed.
    isIgnored(win) {
        return this._rules().some(rule => rule.actions?.ignore?.enabled && this._matches(win, rule));
    }

    // Asked where isIgnored is, before it: saving a rule never closes a window already open.
    isClosed(win) {
        return this._rules().some(rule => rule.actions?.close?.enabled && this._matches(win, rule));
    }

    ownWorkspaceRule(win) {
        const rule = this._rules().find(r =>
            r.actions?.openOnNewWorkspace?.enabled && r.actions.openOnNewWorkspace.value && this._matches(win, r));
        return rule?.id ?? null;
    }

    _matches(win, rule) {
        // one saved before the editor refused it would take every window
        if (!narrows(rule)) return false;
        const c = rule.conditions ?? {};
        if (c.class?.enabled) {
            try { if (!new RegExp(c.class.regex).test(win.get_wm_class() ?? '')) return false; } catch { return false; }
        }
        if (c.title?.enabled) {
            try { if (!new RegExp(c.title.regex).test(win.get_title() ?? '')) return false; } catch { return false; }
        }
        if (c.onAllWorkspaces?.enabled && !win.is_on_all_workspaces()) return false;
        if (c.above?.enabled && !win.above) return false;
        if (c.skipTaskbar?.enabled && !win.skip_taskbar) return false;
        if (c.fullscreen?.enabled && !win.fullscreen) return false;
        // rules are written against Mutter's own flags
        if (c.maximized?.enabled && !(win.maximized_horizontally && win.maximized_vertically)) return false;
        return true;
    }

    _applyOne(win, rule) {
        if (!this._matches(win, rule)) return;
        const a = rule.actions ?? {};
        if (a.onAllWorkspaces?.enabled) {
            if (a.onAllWorkspaces.value) win.stick();
            else win.unstick();
        }
        if (a.above?.enabled) {
            if (a.above.value) win.make_above();
            else win.unmake_above();
        }
        if (a.geometry?.enabled) {
            const wa = win.get_work_area_current_monitor();
            win.move_resize_frame(true,
                Math.round(wa.x + wa.width * a.geometry.x / 100), Math.round(wa.y + wa.height * a.geometry.y / 100),
                Math.round(wa.width * a.geometry.w / 100), Math.round(wa.height * a.geometry.h / 100));
        }
        const rec = this._registry.get(win);
        if (rec) {
            rec.rules.add(rule.id);
            if (a.openOnNewWorkspace?.enabled && a.openOnNewWorkspace.value) rec.ownWsRule = rule.id;
        }
        LOG('rules: applied', rule.id, 'to', name(win));
    }

    // rules-ui reads which rules apply to a window
    appliedTo(win) {
        return this._registry.get(win)?.rules ?? new Set();
    }
}
