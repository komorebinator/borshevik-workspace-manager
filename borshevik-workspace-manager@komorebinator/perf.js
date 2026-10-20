/* perf.js — the performance report: how often each handler and each stage of dispatch runs, how
 * long it takes, and how much the extension holds.
 *
 * Collected only while the perf-log setting is on; off, a measured point costs one check of a
 * flag. It only counts and times: what the numbers mean is for whoever reads the report. Imports
 * nothing of GNOME Shell's, so that preferences, another process, format the report too.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import GLib from 'gi://GLib';

const now = () => GLib.get_monotonic_time();
const stamp = () => GLib.DateTime.new_now_local().format('%F %T');

let on = false;
let since = 0, until = 0, sinceText = '', untilText = '';
const timed = new Map();     // 'kind\u0000name' → { kind, name, calls, us, maxUs, dispatched }
const counts = new Map();    // 'kind\u0000name' → n
const perWindow = new Map(); // window name → { intents, ops }
const live = new Map();      // name → () => number
const running = [];          // the measured points being run, innermost last

export const perfOn = () => on;

export function setPerf(value) {
    if (value === on) return;
    on = value;
    if (on) {
        resetPerf();
    } else {
        until = now();
        untilText = stamp();
    }
}

export function resetPerf() {
    timed.clear();
    counts.clear();
    perWindow.clear();
    since = now();
    sinceText = stamp();
    until = 0;
    untilText = '';
}

// Runs fn, counted and timed under kind and name. Times include whatever fn calls, other measured
// points among them.
export function measure(kind, name, fn, ...args) {
    if (!on) return fn(...args);
    const key = `${kind}\u0000${name}`;
    let s = timed.get(key);
    if (!s) timed.set(key, s = { kind, name, calls: 0, us: 0, maxUs: 0, dispatched: 0 });
    running.push(s);
    const t = now();
    try {
        return fn(...args);
    } finally {
        const dt = now() - t;
        running.pop();
        s.calls++;
        s.us += dt;
        if (dt > s.maxUs) s.maxUs = dt;
    }
}

// fn as a signal handler, measured under 'handler' and name.
export function handler(name, fn) {
    return (...args) => (on ? measure('handler', name, fn, ...args) : fn(...args));
}

export function count(kind, name, n = 1) {
    if (!on) return;
    const key = `${kind}\u0000${name}`;
    counts.set(key, (counts.get(key) ?? 0) + n);
}

// An intent queued: credited to the measured point it was queued from, which is what caused it.
export function noteDispatch(intentType, winNames) {
    if (!on) return;
    count('intent', intentType);
    const by = running.at(-1);
    if (by) by.dispatched++;
    else count('intent from', 'outside any measured handler');
    for (const w of winNames) windowStats(w).intents++;
}

export function noteOp(op, winName) {
    if (!on) return;
    count('op', op);
    if (winName) windowStats(winName).ops++;
}

function windowStats(name) {
    let w = perWindow.get(name);
    if (!w) perWindow.set(name, w = { intents: 0, ops: 0 });
    return w;
}

// How much something holds, read when a report is asked for: records, handlers, states.
export function watchSize(name, fn) {
    live.set(name, fn);
}

export function unwatchSizes() {
    live.clear();
}

const ms = us => Math.round(us / 10) / 100;
// the report's order: an intent's way through dispatch, then what queues intents
const KINDS = ['dispatch', 'snapshot', 'plan', 'execute', 'handler', 'later', 'timer'];
const kindOrder = k => (KINDS.includes(k) ? KINDS.indexOf(k) : KINDS.length);

export function perfReport() {
    const end = until || now();
    const sizes = {};
    for (const [name, fn] of live) {
        try { sizes[name] = fn(); } catch (e) { sizes[name] = `unreadable: ${e.message}`; }
    }
    const group = kind => [...counts].filter(([k]) => k.startsWith(`${kind}\u0000`))
        .map(([k, n]) => ({ name: k.slice(kind.length + 1), n })).sort((a, b) => b.n - a.n);
    return {
        collecting: on,
        since: sinceText || null,
        until: untilText || null,
        seconds: since ? Math.round((end - since) / 1e5) / 10 : 0,
        timed: [...timed.values()].map(s => ({
            kind: s.kind, name: s.name, calls: s.calls, ms: ms(s.us), maxMs: ms(s.maxUs), dispatched: s.dispatched,
        })).sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || b.ms - a.ms),
        intents: group('intent'),
        intentsFrom: group('intent from'),
        emptyPlans: group('empty plan'),
        ops: group('op'),
        other: group('other'),
        windows: [...perWindow].map(([name, w]) => ({ name, ...w }))
            .sort((a, b) => b.intents + b.ops - a.intents - a.ops).slice(0, 15),
        sizes,
    };
}

// The report as text, to be read or pasted.
export function formatReport(r) {
    const out = [];
    const perMin = n => (r.seconds > 0 ? (n * 60 / r.seconds).toFixed(1) : '-');
    const pad = (v, n) => String(v).padStart(n);
    out.push('Borshevik Workspace Manager — performance report');
    if (!r.since) {
        out.push('Nothing collected: the performance log has not been on since the extension started.');
        return out.join('\n');
    }
    out.push(`${r.since} – ${r.until ?? 'now'}, ${r.seconds} s${r.collecting ? ', still collecting' : ''}`);
    out.push('Times include what each one calls.');
    for (const kind of [...new Set(r.timed.map(s => s.kind))]) {
        out.push('', `${kind}:`, `${pad('calls', 8)} ${pad('/min', 8)} ${pad('total ms', 10)} ${pad('max ms', 8)} ${pad('intents', 8)}  name`);
        for (const s of r.timed.filter(x => x.kind === kind))
            out.push(`${pad(s.calls, 8)} ${pad(perMin(s.calls), 8)} ${pad(s.ms, 10)} ${pad(s.maxMs, 8)} ${pad(s.dispatched, 8)}  ${s.name}`);
    }
    const list = (title, rows) => {
        if (!rows.length) return;
        out.push('', `${title}:`);
        for (const x of rows) out.push(`${pad(x.n, 8)} ${pad(perMin(x.n), 8)}  ${x.name}`);
    };
    list('intents queued', r.intents);
    list('intents queued from', r.intentsFrom);
    list('plans that came out empty', r.emptyPlans);
    list('operations carried out', r.ops);
    list('other', r.other);
    if (r.windows.length) {
        out.push('', 'busiest windows:', `${pad('intents', 8)} ${pad('ops', 8)}  window`);
        for (const w of r.windows) out.push(`${pad(w.intents, 8)} ${pad(w.ops, 8)}  ${w.name}`);
    }
    out.push('', 'held now:');
    for (const [name, n] of Object.entries(r.sizes)) out.push(`${pad(n, 8)}  ${name}`);
    return out.join('\n');
}
