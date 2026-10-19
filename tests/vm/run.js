// Acts out the scenarios of tests/scenarios.js against the real GNOME Shell of the test machine
// (@BorshevikWorkspaceManagerWorkflow#test-vm#scenarios). Runs on the host under gjs and works
// the machine through tests/vm.sh: test windows with `open`, keys and drags through QMP, the rest
// through Shell.Eval. Judges only what can be seen — workspaces, halves, minimized, the view —
// so the same scenarios judge any version of the extension.
//
//   gjs -m tests/vm/run.js [filter]
import GLib from 'gi://GLib';
import System from 'system';
import { scenarios, groups } from '../scenarios.js';
import { judge } from '../judge.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const VM = GLib.build_filenamev([here, '..', 'vm.sh']);
const OUT = GLib.build_filenamev([GLib.get_user_cache_dir(), 'borshevik-extensions-vm', 'scenarios']);
const decoder = new TextDecoder();
const sleep = ms => GLib.usleep(ms * 1000);

function vm(...argv) {
    const [, out, err, status] = GLib.spawn_sync(null, [VM, ...argv.map(String)], null, GLib.SpawnFlags.DEFAULT, null);
    let ok = true;
    try { GLib.spawn_check_wait_status(status); } catch { ok = false; }
    return { ok, out: decoder.decode(out).trim(), err: decoder.decode(err).trim() };
}

// Installed into the shell on first use; it runs there, so it may only use what Shell.Eval's
// scope has: global and Main.
function shellHelper(Main) {
    const UUID = 'borshevik-workspace-manager@komorebinator';
    const isChrome = w => /^google-chrome/i.test(w.get_wm_class() ?? '');
    const isAndroid = w => /^waydroid\./.test(w.get_wm_class() ?? '');
    const isTest = w => (w.get_wm_class() ?? '').startsWith('org.borshevik.Test.') || isChrome(w) || isAndroid(w);
    const wins = () => global.display.list_all_windows().filter(w => isTest(w) && w.window_type === 0);
    // a Chrome window is named by its page's title, which the scenario sets
    const nameOf = w => (w.get_title() ?? '').replace(/ [-–] Google Chrome$/, '');
    const find = name => {
        const w = wins().find(x => nameOf(x) === name);
        if (!w) throw new Error(`no window ${name}`);
        return w;
    };
    const wm = () => global.workspace_manager;
    const area = () => {
        const r = wm().get_active_workspace().get_work_area_for_monitor(global.display.get_primary_monitor());
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    // the indicator's workspace buttons as shown: number, icons, '+', and where they are
    const panel = () => {
        const box = Main.panel._leftBox.get_children().find(c => c.has_style_class_name?.('bwm-indicator'));
        if (!box?.visible) return [];
        const below = a => a.get_children().flatMap(c => [c, ...below(c)]);
        return box.get_children().filter(c => c.has_style_class_name?.('bwm-ws')).map(b => {
            const all = below(b), [x, y] = b.get_transformed_position();
            return {
                num: Number(all.find(c => c.has_style_class_name?.('bwm-ws-num'))?.text),
                icons: all.filter(c => c.has_style_class_name?.('bwm-app-icon')).length,
                plus: all.some(c => c.has_style_class_name?.('bwm-ws-plus')),
                x: Math.round(x), y: Math.round(y), w: Math.round(b.width), h: Math.round(b.height),
            };
        });
    };
    const settings = () => {
        const s = Main.extensionManager.lookup(UUID)?.stateObj?.getSettings?.();
        if (!s) throw new Error('the extension is not running');
        return s;
    };
    return {
        state() {
            const list = wins();
            const order = global.display.sort_windows_by_stacking(list);
            return JSON.stringify({
                active: wm().get_active_workspace_index(), n: wm().n_workspaces,
                overview: Main.overview.visible, wa: area(), stage: [global.stage.width, global.stage.height],
                panel: panel(),
                focus: global.display.focus_window && isTest(global.display.focus_window) ? nameOf(global.display.focus_window) : null,
                windows: list.map(w => {
                    const r = w.get_frame_rect();
                    return {
                        name: nameOf(w), ws: w.get_workspace()?.index() ?? -1,
                        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
                        max: w.maximized_horizontally && w.maximized_vertically,
                        fs: w.fullscreen, min: w.minimized, z: order.indexOf(w),
                    };
                }),
            });
        },
        act(name, op, a, b) {
            const w = find(name), t = global.get_current_time(), wa = area();
            switch (op) {
            case 'click': w.activate(t); break;
            case 'maximize': w.maximize(); break;
            case 'unmaximize': w.unmaximize(); break;
            case 'fullscreen': w.make_fullscreen(); break;
            case 'unfullscreen': w.unmake_fullscreen(); break;
            case 'minimize': w.minimize(); break;
            case 'restore': Main.activateWindow(w); break;
            case 'close': w.delete(t); break;
            case 'sendTo':
                // the window moves and the view stays, as when the extension moves a guest off
                w.change_workspace(wm().get_workspace_by_index(a));
                break;
            case 'moveTo': {
                // as Super+Shift+Page Up/Down does: the window moves and the view goes with it
                const ws = wm().get_workspace_by_index(a);
                w.change_workspace(ws);
                ws.activate_with_focus(w, t);
                break;
            }
            case 'place':
                w.move_frame(true, Math.round(wa.x + a * wa.width), Math.round(wa.y + b * wa.height));
                break;
            case 'width': {
                const r = w.get_frame_rect();
                w.move_resize_frame(true, r.x, r.y, Math.round(a * wa.width), r.height);
                break;
            }
            default: throw new Error(`unknown op ${op}`);
            }
            return 'ok';
        },
        activate(i) { wm().get_workspace_by_index(i).activate(global.get_current_time()); return 'ok'; },
        // as dragging a workspace in the indicator does
        reorder(i, to) { wm().reorder_workspace(wm().get_workspace_by_index(i), to); return 'ok'; },
        // as from Extensions; asked for one at a time, since GNOME ignores an enable it is asked
        // for before the disable has taken effect
        extension(on) {
            if (on) Main.extensionManager.enableExtension(UUID);
            else Main.extensionManager.disableExtension(UUID);
            return 'ok';
        },
        extensionOn() { return String(Main.extensionManager.lookup(UUID)?.state === 1); },
        closeAll() { for (const w of wins()) if (!isAndroid(w)) w.delete(global.get_current_time()); return 'ok'; },
        hasAndroid() { return String(wins().some(isAndroid)); },
        set(key, value) {
            const s = settings();
            if (typeof value === 'boolean') s.set_boolean(key, value); else s.set_string(key, value);
            return 'ok';
        },
        reset(key) { settings().reset(key); return 'ok'; },
        // GNOME's focus mode — 'click', 'sloppy' or 'mouse' — for the scenarios that depend on it
        focusMode(mode) {
            new imports.gi.Gio.Settings({ schema_id: 'org.gnome.desktop.wm.preferences' }).set_string('focus-mode', mode);
            return 'ok';
        },
        hideOverview() { Main.overview.hide(); return 'ok'; },
    };
}

// The helper stays in the shell between runs; its own source is its version, so a changed helper
// replaces the one a run before left there.
const HELPER = shellHelper.toString();
const HELPER_VERSION = `${HELPER.length}:${[...HELPER].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)}`;

function shell(call) {
    const code = `(globalThis.bwmTest?.version === ${JSON.stringify(HELPER_VERSION)} ? globalThis.bwmTest
        : (globalThis.bwmTest = Object.assign((${HELPER})(Main), { version: ${JSON.stringify(HELPER_VERSION)} }))).${call}`;
    const r = vm('eval', code);
    if (!r.ok) throw new Error(`eval ${call}: ${r.out || r.err}`);
    return r.out;
}
const q = v => JSON.stringify(v);
const state = () => JSON.parse(shell('state()'));

// Waits until nothing changes over consecutive polls: the extension moves windows over several
// idles and Mutter applies geometry asynchronously, so a fixed delay would judge too early.
function settle(min = 700, max = 12000, polls = 2) {
    sleep(min);
    const start = Date.now();
    let last = null, same = 0;
    while (Date.now() - start < max) {
        const now = shell('state()');
        if (now === last) {
            if (++same >= polls) return JSON.parse(now);
        } else {
            same = 0;
            last = now;
        }
        sleep(300);
    }
    return JSON.parse(last);
}

function waitFor(names, max = 15000) {
    const start = Date.now();
    while (Date.now() - start < max) {
        const st = state();
        if (names.every(n => st.windows.some(w => w.name === n))) return;
        sleep(300);
    }
    throw new Error(`window ${names.join(', ')} did not appear`);
}

function leaveOverview() {
    if (state().overview) { shell('hideOverview()'); sleep(800); }
}

// ── actions ────────────────────────────────────────────────────────────────────

function openArgs(name, opts = {}, wa) {
    const [w, h] = opts.size ?? [0.3, 0.3];
    const args = ['open', name, Math.round(w * wa.width), Math.round(h * wa.height)];
    if (opts.minWidth) args.push('--min-width', Math.round(opts.minWidth * wa.width));
    if (opts.minWidthAfter) args.push('--min-width-after', Math.round(opts.minWidthAfter * 1000));
    if (opts.maximized) args.push('--maximized');
    if (opts.fullscreen) args.push('--fullscreen');
    if (opts.app) args.push('--app', opts.app);
    if (opts.stall) args.push('--stall', Math.round(opts.stall * 1000));
    return args;
}

function wsIndex(spec, st) {
    if (spec === 'last') return st.n - 1;
    if (typeof spec === 'string' && spec.startsWith('ws-of:'))
        return st.windows.find(w => w.name === spec.slice(6)).ws;
    return spec;
}

function titlePoint(st, name) {
    const r = st.windows.find(w => w.name === name).rect;
    return [Math.round(r.x + r.width / 2), Math.round(r.y + 18)];
}

function drag(st, name, to) {
    const [x1, y1] = titlePoint(st, name);
    const wa = st.wa;
    const target = {
        left: [wa.x + 3, wa.y + wa.height / 2],
        right: [wa.x + wa.width - 3, wa.y + wa.height / 2],
        top: [wa.x + wa.width / 2, wa.y + 3],
        away: [wa.x + wa.width * 0.5, wa.y + wa.height * 0.4],
    }[to] ?? [wa.x + to[0] * wa.width, wa.y + to[1] * wa.height];
    const r = vm('drag', x1, y1, Math.round(target[0]), Math.round(target[1]), st.stage[0], st.stage[1]);
    if (!r.ok) throw new Error(`drag: ${r.err}`);
}

const CHROME = ['google-chrome', '--ozone-platform=wayland', '--no-first-run', '--no-default-browser-check',
    // no keyring: GNOME's dialog asking for a new keyring's password takes the keyboard
    '--password-store=basic', '--hide-crash-restore-bubble', '--disable-session-crashed-bubble',
    '--user-data-dir=/var/home/tester/.cache/bwm-chrome'];
const page = title => `data:text/html,<title>${title}</title><h1>${title}</h1>`;

function chromeTabPoint(st, name, index, tabs) {
    const r = st.windows.find(w => w.name === name).rect;
    const tabW = Math.min(240, (r.width - 160) / tabs);
    return [Math.round(r.x + 10 + tabW * (index + 0.5)), Math.round(r.y + 16)];
}

function act(action) {
    const [op, name, arg, opts] = action;
    const st = state();
    switch (op) {
    case 'open': if (arg?.app === 'chrome') {
        leaveOverview();
        const [w, h] = arg.size ?? [0.45, 0.6];
        const r = vm('launch', ...CHROME, `--window-size=${Math.round(w * st.wa.width)},${Math.round(h * st.wa.height)}`,
            '--new-window', ...[name, ...(arg.tabs ?? [])].map(page));
        if (!r.ok) throw new Error(`chrome ${name}: ${r.err}`);
        waitFor([name], 30000);
        if (arg.maximized) { settle(); shell(`act(${q(name)}, 'maximize')`); }
        break;
    } else {
        leaveOverview();
        const r = vm(...openArgs(name, arg, st.wa));
        if (!r.ok) throw new Error(`open ${name}: ${r.err}`);
        if (arg?.gone) settle();
        else waitFor([name]);
        break;
    }
    case 'chromeQuit': {
        // a quit, not window by window: Chrome saves the session it has when it quits
        vm('ssh', 'pkill -TERM -u tester -x chrome');
        const start = Date.now();
        while (state().windows.length && Date.now() - start < 15000) sleep(300);
        break;
    }
    case 'chromeRestore':
        leaveOverview();
        vm('launch', ...CHROME, '--restore-last-session');
        waitFor(name, 30000);
        break;
    case 'dragTab': {
        const [x1, y1] = chromeTabPoint(st, name, arg.index, arg.tabs);
        const wa = st.wa;
        const [x2, y2] = arg.to === 'left' ? [wa.x + 3, wa.y + wa.height / 2] : [wa.x + wa.width - 3, wa.y + wa.height / 2];
        const r = vm('drag', x1, y1, Math.round(x2), Math.round(y2), st.stage[0], st.stage[1]);
        if (!r.ok) throw new Error(`drag tab: ${r.err}`);
        break;
    }
    case 'android':
        // name: the package; arg: the window's title, by which the scenario names it
        leaveOverview();
        // the way a user starts it; reset has given the app's task a box again, since Android
        // remembers the bounds a task last had and would otherwise open it full screen.
        // (`am start` through lxc-attach starts the activity but at times gets no window)
        vm('launch', 'waydroid', 'app', 'launch', name);
        waitFor([arg], 30000);
        break;
    case 'androidFull': case 'androidFloat': {
        // the app's task resized inside Android: to the whole display is what maximizing it in
        // Android does, back to a box is floating it again
        const pkg = arg;
        const tasks = vm('droid', 'am', 'stack', 'list').out;
        const task = new RegExp(`taskId=(\\d+): ${pkg.replace(/\./g, '\\.')}`).exec(tasks)?.[1];
        if (!task) throw new Error(`no Android task for ${pkg}`);
        const box = op === 'androidFull' ? [0, 0, st.stage[0], st.stage[1]] : [300, 120, 800, 680];
        vm('droid', 'am', 'task', 'resize', task, ...box);
        sleep(1500);   // Android's own release waits ANDROID_REPLACE_MS before acting
        break;
    }
    case 'androidTheme':
        vm('droid', 'cmd', 'uimode', 'night', name === 'dark' ? 'yes' : 'no');
        sleep(1500);
        break;
    case 'openMany':
        leaveOverview();
        for (const [n, o] of name) vm(...openArgs(n, o, st.wa));
        waitFor(name.map(([n]) => n));
        break;
    case 'tile':
        shell(`act(${q(name)}, 'click')`);
        sleep(300);
        vm('key', arg === 'left' ? 'super+left' : 'super+right');
        break;
    case 'moveTo':
        shell(`act(${q(name)}, 'moveTo', ${wsIndex(arg, st)})`);
        break;
    case 'sendTo':
        shell(`act(${q(name)}, 'sendTo', ${wsIndex(arg, st)})`);
        break;
    case 'dragWs': {
        // a real drag of a workspace's button in the indicator: name is the workspace's index, or
        // 'plus' for the '+'; arg is { between: [i, j] }, two workspaces' indexes, or 'away'
        const button = spec => st.panel.find(b => (spec === 'plus' ? b.plus : !b.plus && b.num === spec + 1));
        const from = button(name);
        if (!from) throw new Error(`no indicator button for ${name}`);
        const fromAt = st.panel.indexOf(from);
        const spacing = st.panel.length > 1 ? st.panel[1].x - st.panel[0].x - st.panel[0].w : 0;
        const y = from.y + Math.round(from.h / 2);
        let x2, y2 = y;
        if (arg === 'away') {
            x2 = st.wa.x + Math.round(st.wa.width / 2);
            y2 = st.wa.y + Math.round(st.wa.height / 2);
        } else {
            // the middle of the gap that opens before the second: where it stands with the dragged
            // button taken out of the row, plus half the dragged one
            const b = button(arg.between[1]);
            const left = st.panel.indexOf(b) > fromAt ? b.x - from.w - spacing : b.x;
            x2 = Math.round(left + from.w / 2);
        }
        const r = vm('drag', from.x + Math.round(from.w / 2), y, x2, y2, st.stage[0], st.stage[1]);
        if (!r.ok) throw new Error(`drag: ${r.err}`);
        break;
    }
    case 'activate':
        shell(`activate(${wsIndex(name, st)})`);
        break;
    case 'reorder':
        shell(`reorder(${wsIndex(name, st)}, ${arg})`);
        break;
    case 'place':
        shell(`act(${q(name)}, 'place', ${arg[0]}, ${arg[1]})`);
        break;
    case 'drag': drag(st, name, arg); break;
    case 'dragAway': drag(st, name, 'away'); break;
    case 'reenable':
        // turned off and on again: what it knew of the windows is gone
        for (const on of [false, true]) {
            shell(`extension(${on})`);
            const start = Date.now();
            while (shell('extensionOn()') !== String(on)) {
                if (Date.now() - start > 10000) throw new Error(`the extension did not turn ${on ? 'on' : 'off'}`);
                sleep(200);
            }
        }
        break;
    case 'resizeEdge': {
        // a hand on the inner edge of a tile: GTK's resize border lies just outside the frame, so
        // only the border of the window on top can be grabbed there — the tile beside it, if it
        // is above, whose own inner edge is the same one
        const me = st.windows.find(x => x.name === name);
        const w = me.rect;
        const left = Math.abs(w.x - st.wa.x) <= 10;
        const edge = left ? w.x + w.width : w.x;
        const other = st.windows.find(x => x !== me && x.ws === me.ws && !x.min && x.z > me.z &&
            Math.abs((left ? x.rect.x : x.rect.x + x.rect.width) - edge) <= 10);
        const x1 = other ? (left ? edge - 4 : edge + 4) : (left ? edge + 4 : edge - 4);
        const y = Math.round(w.y + w.height / 2);
        const x2 = Math.round(left ? st.wa.x + arg * st.wa.width : st.wa.x + st.wa.width - arg * st.wa.width);
        const r = vm('drag', x1, y, x2, y, st.stage[0], st.stage[1]);
        if (!r.ok) throw new Error(`resize: ${r.err}`);
        break;
    }
    case 'pointer': {
        // arg: where, as shares of the work area; the pointer only moves
        const r = vm('point', Math.round(st.wa.x + arg[0] * st.wa.width), Math.round(st.wa.y + arg[1] * st.wa.height),
            st.stage[0], st.stage[1]);
        if (!r.ok) throw new Error(`pointer: ${r.err}`);
        break;
    }
    case 'clickTitle': {
        const [x, y] = titlePoint(st, name);
        vm('drag', x, y, x, y, st.stage[0], st.stage[1]);
        break;
    }
    default:
        shell(`act(${q(name)}, ${q(op)})`);
    }
    // quick: on to the next step as soon as one poll finds nothing changing, for what a person
    // does at once — not after the shell has been still a while
    return opts?.quick ? settle(150, 12000, 1) : settle();
}

// ── given ──────────────────────────────────────────────────────────────────────

const ruleFor = spec => {
    const [kind, cls] = spec.split(':');
    const off = { enabled: false, value: true };
    return JSON.stringify([{
        id: `test-${kind}`,
        conditions: {
            class: { enabled: true, regex: `^org\\.borshevik\\.Test\\.${cls}` }, title: { enabled: false, regex: '' },
            onAllWorkspaces: off, above: off, skipTaskbar: off, fullscreen: off, maximized: off,
        },
        actions: {
            onAllWorkspaces: off, above: off,
            openOnNewWorkspace: { enabled: kind === 'own-workspace', value: true },
            ignore: { enabled: kind === 'ignore', value: true },
            close: { enabled: kind === 'close', value: true },
            geometry: { enabled: false, x: 0, y: 0, w: 50, h: 50 },
        },
    }]);
};

const TEST_SETTINGS = { 'overview-on-last-workspace': false, 'on-empty-workspace': 'nothing', 'float-sizes': '{}' };

function reset() {
    leaveOverview();
    // a quit Chrome can tell from a crash, so it offers no restore on the next start
    vm('ssh', 'pkill -TERM -u tester -x chrome; for i in $(seq 20); do pgrep -u tester -x chrome >/dev/null || break; sleep 0.5; done; pkill -KILL -u tester -x chrome; true');
    if (shell('hasAndroid()') === 'true') {
        // Android's windows go with their apps; Android remembers the bounds an app's task last
        // had, so it is given a box again first, and the theme goes back to light
        const task = /taskId=(\d+): com\.android\.settings/.exec(vm('droid', 'am', 'stack', 'list').out)?.[1];
        if (task) { vm('droid', 'am', 'task', 'resize', task, 300, 120, 800, 680); sleep(1500); }
        vm('droid', 'am', 'force-stop', 'com.android.settings');
        vm('droid', 'cmd', 'uimode', 'night', 'no');
    }
    shell('closeAll()');
    const start = Date.now();
    while (state().windows.length && Date.now() - start < 10000) sleep(300);
    shell('reset("window-rules")');
    // Borshevik's own default (its ShellCustomizations#defaults), and the author's: focus follows the mouse
    shell("focusMode('sloppy')");
    for (const [k, v] of Object.entries(TEST_SETTINGS)) shell(`set(${q(k)}, ${q(v)})`);
    shell('activate(0)');
    settle(500);
}

const nameOf = spec => typeof spec === 'string' ? spec : spec.name;

function build(given) {
    if (given.focusMode) shell(`focusMode(${q(given.focusMode)})`);
    for (const [k, v] of Object.entries(given.settings ?? {}))
        shell(`set(${q(k)}, ${q(k === 'window-rules' ? ruleFor(v) : v)})`);
    given.workspaces.forEach((ws, i) => {
        if (i > 0) { shell(`activate(${state().n - 1})`); settle(500); }
        if (ws.full) {
            const f = typeof ws.full === 'string' ? { name: ws.full } : ws.full;
            act(['open', f.name, { ...(f.fullscreen ? { fullscreen: true } : { maximized: true }), app: f.app }]);
        }
        for (const side of ['left', 'right']) {
            if (!ws[side]) continue;
            const name = nameOf(ws[side]);
            act(['open', name, ws[side].app ? { app: ws[side].app } : undefined]);
            act(['tile', name, side]);
            if (ws[side].width) act(['resizeEdge', name, ws[side].width]);
        }
        for (const f of ws.floating ?? []) {
            const spec = typeof f === 'string' ? { name: f } : f;
            act(['open', spec.name, spec]);
            if (spec.place) act(['place', spec.name, spec.place]);
        }
    });
    shell(`activate(${wsIndex(given.active ?? 0, state())})`);
    return settle();
}

// ── running ────────────────────────────────────────────────────────────────────

function evidence(id, since) {
    GLib.mkdir_with_parents(OUT, 0o755);
    const base = GLib.build_filenamev([OUT, id.replace('#', '--')]);
    vm('shot', `${base}.png`);
    const log = vm('ssh', `journalctl -b --since @${since} -o cat _COMM=gnome-shell | grep -E 'BWM|JS ERROR|Error' | tail -60`);
    GLib.file_set_contents(`${base}.log`, log.out);
    return base;
}

// ── which groups run ──────────────────────────────────────────────────────────

const args = [...System.programArgs];
const selectAt = args.indexOf('--select');
const select = selectAt >= 0 ? args.splice(selectAt, 2)[1] : 'auto';
const filter = args[0] ?? '';
const root = GLib.path_get_dirname(GLib.path_get_dirname(here));

function git(...argv) {
    const [, out] = GLib.spawn_sync(root, ['git', ...argv], null, GLib.SpawnFlags.SEARCH_PATH, null);
    return decoder.decode(out).split('\n').filter(Boolean);
}

const globRe = g => new RegExp('^' + g.split('**').map(p => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('.*') + '$');

function chosenGroups() {
    if (select === 'all') return { groups: new Set(Object.keys(groups)), why: 'all, as asked' };
    if (select === 'none') return { groups: new Set(), why: 'none, as asked' };
    const base = git('merge-base', 'HEAD', 'origin/main')[0] ?? 'HEAD';
    const changed = new Set([...git('diff', '--name-only', base), ...git('ls-files', '--others', '--exclude-standard')]);
    const picked = new Set(), reasons = [];
    for (const [g, { paths }] of Object.entries(groups)) {
        const hit = [...changed].find(f => paths.some(p => globRe(p).test(f)));
        if (hit) { picked.add(g); reasons.push(`${g} (${hit} changed)`); }
    }
    return { groups: picked, why: reasons.length ? reasons.join(', ') : 'none touched by the change' };
}

const { groups: picked, why } = chosenGroups();
print(`groups: ${why}`);
if (picked.has('android')) {
    // brings Android up when it is not, and up to date: the group cannot run without it
    const up = vm('droid', 'getprop', 'sys.boot_completed').out.trim();
    if (up !== '1') {
        print('starting Android for the android group');
        const r = vm('android');
        if (!r.ok) throw new Error(`Android would not start: ${r.err || r.out}`);
    }
}
const chosen = scenarios.filter(s => `${s.id}${s.group ? ` [${s.group}]` : ''}`.includes(filter) && (!s.group || picked.has(s.group)));
let failed = 0, passed = 0, skipped = 0;

if (vm('eval', 'typeof Main').out !== 'object') throw new Error('Shell.Eval has no Main in scope');

for (const s of chosen) {
    const label = `${s.id}${s.group ? ` [${s.group}]` : ''}`;
    if (s.skip?.vm) { skipped++; print(`SKIP ${label}: ${s.skip.vm}`); continue; }
    const since = vm('ssh', 'date +%s').out;
    let errors;
    try {
        reset();
        const initial = build(s.given);
        let before = initial;
        for (const step of s.given.steps ?? []) before = act(step);
        const after = act(s.when);
        errors = judge(s.then, after, before, initial);
    } catch (e) {
        errors = [`error: ${e.message}`];
    }
    if (errors.length) {
        failed++;
        const base = evidence(label.replace(/[ \[\]]/g, ''), since);
        print(`FAIL ${label}\n      ${errors.join('\n      ')}\n      evidence: ${base}.png, ${base}.log`);
    } else {
        passed++;
        print(`ok   ${label}`);
    }
}
try { reset(); } catch {}
print(`\n${passed} ok, ${failed} failed, ${skipped} skipped`);
System.exit(failed ? 1 : 0);
