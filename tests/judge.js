// Judges a scenario's `then` against what can be seen, for both levels that act scenarios out
// (tests/vm/run.js, tests/planner/run.js): which workspace each window is on, whether it fills a
// half, the whole work area or neither, whether it is minimized, which workspace is shown.
//
// A state is { active, n, overview, wa, focus, windows: [{ name, ws, rect, max, fs, min, z }], panel },
// panel being the indicator's workspace buttons as shown, [{ num, icons, plus, x, y, w, h }]: the
// test machine's only, the planner having no indicator. So are perf and perfBefore, the extension's
// performance report taken after the scenario's `when` and right before it (perf.js#perfReport).
import { helpers } from './scenarios.js';

export function role(w, wa, tol = 10) {
    if (w.min) return 'min';
    if (w.fs || w.max) return 'full';
    const r = w.rect;
    const tall = Math.abs(r.y - wa.y) <= tol && Math.abs(r.height - wa.height) <= tol;
    const narrower = r.width < wa.width - tol;
    if (tall && narrower && Math.abs(r.x - wa.x) <= tol) return 'left';
    if (tall && narrower && Math.abs(r.x + r.width - wa.x - wa.width) <= tol) return 'right';
    return 'float';
}

export function observe(st) {
    const workspaces = Array.from({ length: st.n }, () => ({ tiles: {}, full: [], floating: [], minimized: [] }));
    for (const w of st.windows) {
        const ws = workspaces[w.ws];
        if (!ws) continue;
        const r = role(w, st.wa);
        if (r === 'left' || r === 'right') ws.tiles[w.name] = r;
        else if (r === 'full') ws.full.push(w.name);
        else if (r === 'min') ws.minimized.push(w.name);
        else ws.floating.push(w.name);
    }
    const empty = ws => !Object.keys(ws.tiles).length && !ws.full.length && !ws.floating.length && !ws.minimized.length;
    while (workspaces.length && empty(workspaces.at(-1))) workspaces.pop();
    return workspaces;
}

const sorted = a => [...a].sort().join(',');

export const describe = ws => {
    const parts = Object.entries(ws.tiles).map(([n, s]) => `${s}:${n}`);
    if (ws.full.length) parts.push(`full:${ws.full.join(',')}`);
    if (ws.floating.length) parts.push(`floating:${sorted(ws.floating)}`);
    if (ws.minimized.length) parts.push(`minimized:${sorted(ws.minimized)}`);
    return `[${parts.join(' ')}]`;
};

export const describeExpected = ws => {
    const parts = [];
    if (ws.left) parts.push(`left:${ws.left}`);
    if (ws.right) parts.push(`right:${ws.right}`);
    if (ws.tiled) parts.push(`tiled:${ws.tiled.join(',')}`);
    if (ws.full) parts.push(`full:${ws.full}`);
    if (ws.floating) parts.push(`floating:${sorted(ws.floating)}`);
    if (ws.minimized) parts.push(`minimized:${sorted(ws.minimized)}`);
    return `[${parts.join(' ')}]`;
};

const sameSet = (a = [], b = []) => a.length === b.length && a.every(x => b.includes(x));

function matches(exp, act) {
    for (const side of ['left', 'right'])
        if (exp[side] && act.tiles[exp[side]] !== side) return false;
    const tiles = [exp.left, exp.right, ...(exp.tiled ?? [])].filter(Boolean);
    if (!sameSet(tiles, Object.keys(act.tiles))) return false;
    if (!sameSet(exp.full ? [exp.full] : [], act.full)) return false;
    return sameSet(exp.floating, act.floating) && sameSet(exp.minimized, act.minimized);
}

function view(st, before, initial) {
    const rectOf = (s, n) => s.windows.find(w => w.name === n)?.rect;
    const win = n => {
        const w = st.windows.find(x => x.name === n);
        return w && { ...w, role: role(w, st.wa), full: w.fs || w.max };
    };
    const changed = (s, n, what) => helpers.sameRect(rectOf(st, n), rectOf(s, n)) ? null : `${n} moved or resized ${what}`.trim();
    return {
        wa: st.wa, overview: st.overview, active: st.active, panel: st.panel ?? [],
        perf: st.perf, perfBefore: st.perfBefore,
        rect: n => rectOf(st, n), win,
        windowsOn: i => st.windows.filter(w => w.ws === i),
        share: (w, h) => ({ width: w * st.wa.width, height: h * st.wa.height }),
        before: { rect: n => rectOf(before, n) },
        unchanged: n => changed(before, n, ''),
        unchangedSinceGiven: n => changed(initial, n, 'since the layout was built'),
    };
}

export function judge(then, st, before, initial) {
    const errors = [];
    const actual = observe(st);
    if (then.workspaces) {
        const ok = then.workspaces.length === actual.length && then.workspaces.every((e, i) => matches(e, actual[i]));
        if (!ok) errors.push(`expected ${then.workspaces.map(describeExpected).join(' ')}\n      found    ${actual.map(describe).join(' ')}`);
    }
    if (then.active !== undefined && st.active !== then.active)
        errors.push(`expected workspace ${then.active} shown, found ${st.active}`);
    if (then.focused !== undefined && st.focus !== then.focused)
        errors.push(`expected ${then.focused} focused, found ${st.focus ?? 'nothing'}`);
    // judged by the performance report, which only the test machine has
    if (then.quiet && st.perf?.ops.length)
        errors.push(`expected the extension to do nothing, found ${st.perf.ops.map(o => `${o.n} ${o.name}`).join(', ')}`);
    if (then.check) {
        let e;
        try { e = then.check(view(st, before, initial)); } catch (x) { e = `check threw: ${x.message}`; }
        if (e) errors.push(e);
    }
    return errors;
}
