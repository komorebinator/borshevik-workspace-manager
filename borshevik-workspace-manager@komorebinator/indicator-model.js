/* indicator-model.js — what the panel indicator shows, apart from how it is shown.
 *
 * readWall reads the wall into plain data, one entry per button; diff says what changed from one
 * reading to the next, as the changes the view applies one by one. Neither touches an actor: the
 * view is free to animate each change, and diff is tested on plain objects (tests/indicator).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A button, as an entry: ws, the workspace, which is also what tells entries apart from one
// reading to the next; num, its number as shown; active; plus, the empty last workspace's '+';
// icons, its windows' in the order shown, each { id, app } — id the window's own, so two
// windows of one app are two icons.

const ORDER = { full: 1, 'tiled-left': 2, 'tiled-right': 3 };

export function readWall({ registry, isRelevant, tracker }) {
    const wm = global.workspace_manager;
    const n = wm.get_n_workspaces();
    const activeI = wm.get_active_workspace_index();
    const rank = w => (w.fullscreen ? 0 : ORDER[registry.get(w)?.role] ?? 4);
    const entries = [];
    for (let i = 0; i < n; i++) {
        const ws = wm.get_workspace_by_index(i);
        const wins = ws.list_windows()
            .filter(w => isRelevant(w) && !w.on_all_workspaces && !w.skip_pager && w.get_workspace() === ws)
            .sort((a, b) => rank(a) - rank(b));
        const plus = i === n - 1 && wins.length === 0;
        // an empty workspace is shown only while it is the one shown, or as the '+'
        if (wins.length === 0 && !plus && (i !== activeI || n === 1)) continue;
        if (wins.length === 0 && n === 1) continue;
        const icons = [];
        if (!plus) {
            for (const w of wins) {
                const app = tracker.get_window_app(w);
                if (app) icons.push({ id: `${w.get_id()}:${app.get_id()}`, app });
            }
        }
        entries.push({ ws, num: i + 1, active: i === activeI, plus, icons });
    }
    return entries;
}

// The positions of the longest run of xs that rises, left to right: the buttons that kept their
// order among themselves, so that only the others are said to have moved.
function rising(xs) {
    const len = xs.map(() => 1), prev = xs.map(() => -1);
    for (let i = 0; i < xs.length; i++) {
        for (let j = 0; j < i; j++) {
            if (xs[j] < xs[i] && len[j] + 1 > len[i]) {
                len[i] = len[j] + 1;
                prev[i] = j;
            }
        }
    }
    const keep = new Set();
    let i = len.indexOf(Math.max(0, ...len));
    while (i >= 0) {
        keep.add(i);
        i = prev[i];
    }
    return keep;
}

const sameIcons = (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id);

// What changed from prev to next, in the order to apply it: removed buttons, added ones (at their
// index in next), the ones that moved (from and to, their indexes among the buttons both have; as
// few as can be, the others keeping their order), then each one's own changes — num, active,
// icons (the '+' among them, an empty last workspace's icon).
export function diff(prev, next) {
    const changes = [];
    const nextWs = new Set(next.map(e => e.ws));
    const prevBy = new Map(prev.map(e => [e.ws, e]));
    for (const e of prev) if (!nextWs.has(e.ws)) changes.push({ type: 'removed', entry: e });
    next.forEach((e, at) => {
        if (!prevBy.has(e.ws)) changes.push({ type: 'added', entry: e, at });
    });
    const keptBefore = prev.filter(e => nextWs.has(e.ws)).map(e => e.ws);
    const keptAfter = next.filter(e => prevBy.has(e.ws)).map(e => e.ws);
    const from = keptAfter.map(ws => keptBefore.indexOf(ws));
    const stayed = rising(from);
    keptAfter.forEach((ws, to) => {
        if (!stayed.has(to)) changes.push({ type: 'moved', entry: next.find(e => e.ws === ws), from: from[to], to });
    });
    for (const e of next) {
        const old = prevBy.get(e.ws);
        if (!old) continue;
        if (old.num !== e.num) changes.push({ type: 'num', entry: e });
        if (old.active !== e.active) changes.push({ type: 'active', entry: e });
        if (old.plus !== e.plus || !sameIcons(old.icons, e.icons)) changes.push({ type: 'icons', entry: e });
    }
    return changes;
}
