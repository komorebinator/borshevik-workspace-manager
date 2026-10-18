// Acts out the scenarios of tests/scenarios.js against planner.js alone
// (@BorshevikWorkspaceManagerExtension#tests#planner-scenarios). A small world stands in for
// Mutter: actions become intents the way the adapters would make them, plans are applied the way
// executor would apply them, and empty workspaces go the way GNOME's dynamic workspaces take them.
// No GNOME Shell is needed.
//
//   gjs -m tests/planner/run.js [filter]
import System from 'system';
import { scenarios } from '../scenarios.js';
import { judge } from '../judge.js';
import { plan } from '../../borshevik-workspace-manager@komorebinator/planner.js';

const WA = { x: 0, y: 32, width: 1280, height: 768 };

class World {
    constructor() {
        this.workspaces = [{ id: 'ws0', windows: [] }];
        this.active = 0;
        this.floatSizes = {};
        this.rules = {};
        this.z = 0;
        this.ids = 1;
        this.created = 0;
        this.focus = null;
    }

    find(name) {
        for (const s of this.workspaces) {
            const w = s.windows.find(x => x.name === name);
            if (w) return w;
        }
        throw new Error(`no window ${name}`);
    }

    wsIndexOf(w) { return this.workspaces.findIndex(s => s.windows.includes(w)); }
    wsIndexById(id) { return this.workspaces.findIndex(s => s.id === id); }

    // GNOME keeps exactly one empty workspace at the end, and removes other empty ones unless shown.
    tidy() {
        const activeWs = this.workspaces[this.active];
        this.workspaces = this.workspaces.filter((s, i) => s.windows.length || s === activeWs || i === this.workspaces.length - 1);
        if (this.workspaces.at(-1).windows.length) this.workspaces.push({ id: `ws${this.ids++}`, windows: [] });
        while (this.workspaces.length > 1 && !this.workspaces.at(-1).windows.length
               && !this.workspaces.at(-2).windows.length && this.workspaces.at(-2) !== activeWs)
            this.workspaces.splice(-2, 1);
        this.active = Math.max(0, this.workspaces.indexOf(activeWs));
    }

    snapshot(opening = []) {
        return {
            workArea: WA,
            activeWs: this.workspaces[this.active].id,
            workspaces: this.workspaces.map(s => ({
                ws: s.id,
                // in the order the windows were registered, as snapshot#take lists them
                windows: [...s.windows].sort((a, b) => a.created - b.created).map(w => ({
                    win: w, role: w.role, rect: { ...w.rect }, z: w.z, minimized: w.minimized,
                    fullscreen: w.fullscreen, home: w.home, preFull: w.preFull,
                    floatRect: w.role === 'floating' && !opening.includes(w) ? { ...w.rect } : w.floatRect,
                    appFloatSize: this.floatSizes[w.app], minWidth: w.minWidth,
                    ownWsRule: this.ownWsRule(w), minimizedFrom: w.minimizedFrom,
                })),
            })),
        };
    }

    ownWsRule(w) {
        const r = this.rules['own-workspace'];
        return r && w.app.startsWith(r) ? 'own-workspace' : null;
    }

    ignored(w) {
        const r = this.rules.ignore;
        return r && w.app.startsWith(r);
    }

    closedByRule(w) {
        const r = this.rules.close;
        return r && w.app.startsWith(r);
    }

    state() {
        return {
            active: this.active, n: this.workspaces.length, overview: false, wa: WA, focus: this.focus?.name ?? null,
            windows: this.workspaces.flatMap((s, i) => s.windows.map(w => ({
                name: w.name, ws: i, rect: { ...w.rect }, max: w.role === 'full' && !w.fullscreen,
                fs: w.fullscreen, min: w.minimized, z: w.z,
            }))),
        };
    }

    // GNOME's own focus: a window that leaves the workspace shown, or is minimized, hands the focus
    // to the topmost window there
    refocus() {
        const shown = this.workspaces[this.active]?.windows ?? [];
        if (this.focus && shown.includes(this.focus) && !this.focus.minimized) return;
        const top = shown.filter(w => !w.minimized).sort((a, b) => b.z - a.z)[0];
        this.focus = top ?? null;
    }

    dispatch(intent) {
        const p = plan(this.snapshot(intent.type === 'opened' ? intent.wins : []), intent);
        this.apply(p);
        this.tidy();
        this.refocus();
        // dispatch's recheck of what the plan touched, once its windows have settled
        for (const id of p.touched ?? []) {
            if (typeof id !== 'string' || this.wsIndexById(id) < 0) continue;
            this.apply(plan(this.snapshot(), { type: 'recheck', ws: id }));
            this.tidy();
        }
    }

    resolveWs(ref, refs) {
        if (typeof ref === 'string') return this.wsIndexById(ref);
        return this.wsIndexById(refs.get(ref));
    }

    apply(p) {
        const refs = new Map();
        for (const op of p.ops) {
            const w = op.win;
            switch (op.op) {
            case 'newWorkspace': {
                const id = `ws${this.ids++}`;
                refs.set(op.ref, id);
                const anchor = this.resolveWs(op.before ?? op.after, refs);
                const shown = this.workspaces[this.active];
                this.workspaces.splice(op.before ? anchor : anchor + 1, 0, { id, windows: [] });
                this.active = this.workspaces.indexOf(shown);
                break;
            }
            case 'move': {
                const from = this.wsIndexOf(w), to = this.resolveWs(op.ws, refs);
                this.workspaces[from].windows.splice(this.workspaces[from].windows.indexOf(w), 1);
                this.workspaces[to].windows.push(w);
                break;
            }
            case 'tile':
                w.role = `tiled-${op.side}`;
                w.fullscreen = false;
                w.rect = { ...op.rect };
                if (w.minWidth && w.rect.width < w.minWidth) {
                    // a window with a smallest width settles wider than asked; executor reports it
                    if (op.side === 'right') w.rect.x -= w.minWidth - w.rect.width;
                    w.rect.width = w.minWidth;
                    (this.settled ??= []).push({ win: w, width: w.minWidth });
                }
                break;
            case 'full':
                w.role = 'full';
                w.preFull = op.preFull;
                w.rect = { ...WA };
                break;
            case 'float':
                w.role = 'floating';
                w.fullscreen = false;
                if (op.rect) w.rect = { ...op.rect };
                else w.rect = { ...w.rect, x: WA.x + (WA.width - 400) / 2, y: WA.y + (WA.height - 300) / 2, width: 400, height: 300 };
                break;
            case 'place': w.rect = { ...w.rect, x: op.x, y: op.y }; break;
            case 'home': w.home = op.home && { ...op.home, ws: typeof op.home.ws === 'string' ? op.home.ws : refs.get(op.home.ws) }; break;
            case 'floatSize':
                w.floatRect = { ...op.rect };
                this.floatSizes[w.app] = { wr: op.rect.width / WA.width, hr: op.rect.height / WA.height };
                break;
            case 'raise': w.z = ++this.z; break;
            case 'lower': {
                const below = op.below.map(b => b.z);
                w.z = Math.min(...below) - 0.5;
                break;
            }
            case 'minimizedFrom': w.minimizedFrom = op.value; break;
            case 'floatRect': w.floatRect = { ...op.rect }; break;
            }
        }
        if (p.activate) this.active = this.resolveWs(p.activate, refs);
        if (p.focus) this.focus = p.focus;
        const settled = this.settled ?? [];
        this.settled = [];
        for (const s of settled) this.dispatch({ type: 'settled', win: s.win, width: s.width });
    }

    // ── what the user and Mutter do ────────────────────────────────────────────

    open(name, opts = {}) {
        const [sw, sh] = opts.size ?? [0.3, 0.3];
        const width = Math.round(sw * WA.width), height = Math.round(sh * WA.height);
        const w = {
            name, app: opts.app ?? name, z: ++this.z, created: ++this.created, minimized: false, fullscreen: !!opts.fullscreen,
            role: opts.maximized || opts.fullscreen ? 'full' : 'floating', home: null,
            minWidth: opts.minWidth ? Math.round(opts.minWidth * WA.width) : 0,
            rect: opts.maximized || opts.fullscreen ? { ...WA }
                : { x: WA.x + Math.round((WA.width - width) / 2), y: WA.y + Math.round((WA.height - height) / 2), width, height },
        };
        // windows#register: its app's remembered size centred, else the geometry it opened with
        const app = this.floatSizes[w.app];
        if (app) {
            const fw = Math.round(WA.width * app.wr), fh = Math.round(WA.height * app.hr);
            w.floatRect = { x: WA.x + Math.round((WA.width - fw) / 2), y: WA.y + Math.round((WA.height - fh) / 2), width: fw, height: fh };
        } else if (w.role !== 'full') {
            w.floatRect = { ...w.rect };
        }
        this.workspaces[this.active].windows.push(w);
        return w;
    }

    act([op, name, arg]) {
        // the window the user acts on has the focus, as a click or a key on it gives it
        if (typeof name === 'string' && !['close', 'minimize', 'activate'].includes(op)) {
            try { this.focus = this.find(name); } catch {}
        }
        this.actOn([op, name, arg]);
        this.refocus();
    }

    actOn([op, name, arg]) {
        switch (op) {
        case 'open': {
            const w = this.open(name, arg);
            if (this.closedByRule(w)) {
                const ws = this.workspaces[this.active].windows;
                ws.splice(ws.indexOf(w), 1);
                return;
            }
            if (this.ignored(w)) return;
            this.dispatch({ type: 'opened', wins: [w] });
            break;
        }
        case 'openMany':
            this.dispatch({ type: 'opened', wins: name.map(([n, o]) => this.open(n, o)) });
            break;
        case 'tile': {
            const w = this.find(name);
            w.z = ++this.z;
            if (w.role === `tiled-${arg}`) this.dispatch({ type: 'untile', win: w });
            else this.dispatch({ type: 'tile', win: w, side: arg, explicit: true });
            break;
        }
        case 'maximize': this.dispatch({ type: 'full', win: this.find(name) }); break;
        case 'unmaximize': this.dispatch({ type: 'unfull', win: this.find(name) }); break;
        case 'fullscreen': { const w = this.find(name); w.fullscreen = true; this.dispatch({ type: 'full', win: w }); break; }
        case 'unfullscreen': { const w = this.find(name); w.fullscreen = false; this.dispatch({ type: 'unfull', win: w }); break; }
        case 'minimize': { const w = this.find(name); w.minimized = true; this.dispatch({ type: 'minimized', win: w }); break; }
        case 'restore': {
            const w = this.find(name);
            w.minimized = false;
            this.active = this.wsIndexOf(w);   // GNOME's activation shows the window's workspace first
            w.z = ++this.z;
            this.dispatch({ type: 'restored', win: w });
            break;
        }
        case 'close': {
            const w = this.find(name);
            const i = this.wsIndexOf(w);
            const slot = w.role === 'tiled-left' ? 'left' : w.role === 'tiled-right' ? 'right' : null;
            this.workspaces[i].windows.splice(this.workspaces[i].windows.indexOf(w), 1);
            this.tidy();
            this.dispatch({ type: 'closed', ws: this.workspaces[this.wsIndexOf(w)]?.id ?? this.idOfRemoved(i, w), slot });
            break;
        }
        case 'click': {
            const w = this.find(name);
            w.z = ++this.z;
            this.dispatch({ type: 'recheck', ws: this.workspaces[this.wsIndexOf(w)].id });
            break;
        }
        case 'moveTo': {
            const w = this.find(name);
            const from = this.wsIndexOf(w);
            const to = this.index(arg);
            const fromId = this.workspaces[from].id;
            this.workspaces[from].windows.splice(this.workspaces[from].windows.indexOf(w), 1);
            this.workspaces[to].windows.push(w);
            this.active = to;
            this.tidy();
            this.dispatch({ type: 'userMoved', win: w, from: fromId });
            break;
        }
        case 'activate': this.active = this.index(name); this.tidy(); break;
        case 'place': {
            const w = this.find(name);
            w.rect = { ...w.rect, x: Math.round(WA.x + arg[0] * WA.width), y: Math.round(WA.y + arg[1] * WA.height) };
            break;
        }
        case 'drag': case 'dragAway': {
            const w = this.find(name);
            w.z = ++this.z;
            const zone = op === 'dragAway' ? null : arg === 'top' ? 'maximize' : typeof arg === 'string' ? arg : null;
            if (w.role !== 'floating') this.dispatch({ type: 'detached', win: w });
            // the window follows the pointer while it is dragged
            const to = op === 'dragAway' ? [0.5, 0.4] : Array.isArray(arg) ? arg : null;
            if (to) w.rect = { ...w.rect, x: Math.round(WA.x + to[0] * WA.width - w.rect.width / 2), y: Math.round(WA.y + to[1] * WA.height) };
            if (zone) {
                this.dispatch({ type: 'dropped', win: w, zone });
            }
            break;
        }
        case 'resizeEdge': {
            const w = this.find(name);
            w.rect = { ...w.rect, width: Math.round(arg * WA.width) };
            if (w.role === 'tiled-right') w.rect.x = WA.x + WA.width - w.rect.width;
            this.dispatch({ type: 'resized', win: w, width: w.rect.width });
            break;
        }
        case 'clickTitle': break;
        case 'pointer': break;   // the planner knows no pointer; GNOME's focus here is click-to-focus
        default: throw new Error(`unknown action ${op}`);
        }
    }

    idOfRemoved(i, w) { return this.closedWsId; }

    index(spec) {
        if (spec === 'last') return this.workspaces.length - 1;
        if (typeof spec === 'string' && spec.startsWith('ws-of:')) return this.wsIndexOf(this.find(spec.slice(6)));
        return spec;
    }
}

// The closed intent names the workspace the window was on; capture it before the window goes.
const closeAct = World.prototype.act;
World.prototype.act = function (action) {
    if (action[0] === 'close') {
        const w = this.find(action[1]);
        this.closedWsId = this.workspaces[this.wsIndexOf(w)].id;
    }
    return closeAct.call(this, action);
};

function build(world, given) {
    for (const [k, v] of Object.entries(given.settings ?? {})) {
        if (k === 'window-rules') {
            const [kind, cls] = v.split(':');
            world.rules[kind] = cls;
        }
    }
    given.workspaces.forEach((ws, i) => {
        if (i > 0) { world.active = world.workspaces.length - 1; world.tidy(); }
        if (ws.full) {
            const f = typeof ws.full === 'string' ? { name: ws.full } : ws.full;
            world.act(['open', f.name, f.fullscreen ? { fullscreen: true } : { maximized: true }]);
        }
        for (const side of ['left', 'right']) {
            if (!ws[side]) continue;
            const name = typeof ws[side] === 'string' ? ws[side] : ws[side].name;
            world.act(['open', name]);
            world.act(['tile', name, side]);
            if (ws[side].width) {
                const w = world.find(name);
                w.rect = { ...w.rect, width: Math.round(ws[side].width * WA.width) };
                if (side === 'right') w.rect.x = WA.x + WA.width - w.rect.width;
            }
        }
        for (const f of ws.floating ?? []) {
            const spec = typeof f === 'string' ? { name: f } : f;
            world.act(['open', spec.name, spec]);
            if (spec.place) world.act(['place', spec.name, spec.place]);
        }
        world.tidy();
    });
    world.active = world.index(given.active ?? 0);
    world.tidy();
}

const filter = System.programArgs[0] ?? '';
let failed = 0, passed = 0, skipped = 0;
for (const s of scenarios.filter(x => x.id.includes(filter))) {
    if (s.group) continue;   // with a real app: the VM's alone
    if (s.skip?.planner) { skipped++; print(`SKIP ${s.id}: ${s.skip.planner}`); continue; }
    let errors;
    try {
        const world = new World();
        build(world, s.given);
        const initial = world.state();
        let before = initial;
        for (const step of s.given.steps ?? []) { world.act(step); before = world.state(); }
        world.act(s.when);
        errors = judge(s.then, world.state(), before, initial);
    } catch (e) {
        errors = [`error: ${e.message}\n${e.stack}`];
    }
    if (errors.length) { failed++; print(`FAIL ${s.id}\n      ${errors.join('\n      ')}`); }
    else { passed++; print(`ok   ${s.id}`); }
}
print(`\n${passed} ok, ${failed} failed, ${skipped} skipped`);
System.exit(failed ? 1 : 0);
