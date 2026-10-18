/* extension.js — Borshevik Workspace Manager.
 *
 * Keeps the primary monitor's workspaces as a wall. Adapters (windows, drag, android, the
 * keybindings) turn what happens into intents; dispatch takes a snapshot, asks the planner for a
 * plan and has the executor carry it out — one intent at a time, always at idle.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { LOG, logging, name, setLogging } from './log.js';
import { Registry } from './registry.js';
import { plan } from './planner.js';
import { take } from './snapshot.js';
import { Executor } from './executor.js';
import { WindowTracker } from './windows.js';
import { DragController } from './drag.js';
import { AndroidWindows } from './android.js';
import { WindowRules } from './rules.js';
import { Indicator } from './indicator.js';
import { WindowRulesUI } from './window-rules-ui.js';

// ── the debug log of a plan: what the planner saw, what it decided, and why ──

const fmtRect = r => r ? `${r.x},${r.y} ${r.width}x${r.height}` : '-';

function fmtWs(ws, snapshot) {
    if (!ws) return '-';
    if (ws.newWorkspace) return `new#${ws.newWorkspace}`;
    const i = snapshot.workspaces.findIndex(s => s.ws === ws);
    return i >= 0 ? `ws${i}` : `ws?${ws.index?.() ?? ''}`;
}

function fmtOp(o, snapshot) {
    const parts = [o.op, o.win ? name(o.win) : ''];
    if (o.ws) parts.push('→', fmtWs(o.ws, snapshot));
    if (o.ref) parts.push(fmtWs(o.ref, snapshot), o.before ? `before ${fmtWs(o.before, snapshot)}` : `after ${fmtWs(o.after, snapshot)}`);
    if (o.side) parts.push(o.side);
    if (o.op === 'tile' || o.op === 'float' || o.op === 'floatRect' || o.op === 'floatSize') parts.push(fmtRect(o.rect));
    if (o.keepPosition) parts.push('keepPosition');
    if (o.op === 'place') parts.push(`${o.x},${o.y}`);
    if (o.op === 'full') parts.push(`preFull=${o.preFull}`);
    if (o.op === 'home') parts.push(o.home ? `${fmtWs(o.home.ws, snapshot)}/${o.home.kind}/${o.home.slot ?? '-'}` : 'null');
    if (o.op === 'minimizedFrom') parts.push(o.value ? `${fmtWs(o.value.ws, snapshot)}/${o.value.slot ?? '-'}` : 'null');
    if (o.op === 'lower' && o.below) parts.push('below', [].concat(o.below).map(name).join(','));
    return parts.filter(Boolean).join(' ');
}

function logPlan(snapshot, intent, p) {
    LOG(`  wall: wa=${fmtRect(snapshot.workArea)} active=${fmtWs(snapshot.activeWs, snapshot)}`);
    snapshot.workspaces.forEach((s, i) => {
        if (!s.windows.length) {
            LOG(`  ws${i}: empty`);
            return;
        }
        for (const w of s.windows) {
            const home = w.home ? ` home=${fmtWs(w.home.ws, snapshot)}/${w.home.kind}/${w.home.slot ?? '-'}` : '';
            LOG(`  ws${i}: ${name(w.win)} ${w.role} ${fmtRect(w.rect)} z=${w.z}` +
                `${w.minimized ? ' minimized' : ''}${w.fullscreen ? ' fullscreen' : ''}${w.above ? ' above' : ''}` +
                `${home} float=${fmtRect(w.floatRect)}` +
                `${w.appFloatSize ? ` app=${w.appFloatSize.wr.toFixed(2)}x${w.appFloatSize.hr.toFixed(2)}` : ''}` +
                `${w.transientFor ? ' transient' : ''}`);
        }
    });
    if (intent.type === 'opened') LOG(`  opened: ${intent.wins.map(name).join(' ')}`);
    if (intent.from) LOG(`  from: ${fmtWs(intent.from, snapshot)}`);
    if (intent.zone || intent.side || intent.width !== undefined)
        LOG(`  intent: zone=${intent.zone ?? '-'} side=${intent.side ?? '-'} explicit=${intent.explicit ?? '-'} width=${intent.width ?? '-'}`);
    for (const o of p.ops) LOG(`  op: ${fmtOp(o, snapshot)}`);
    for (const n of p.notes ?? []) {
        LOG(`  evicted ${name(n.evicted)} ${fmtRect(n.rect)} z=${n.z}, covered by: ` +
            n.covers.map(c => `${name(c.win)} ${c.role} ${fmtRect(c.rect)} z=${c.z}`).join('; '));
    }
    if (p.activate) LOG(`  show: ${fmtWs(p.activate, snapshot)}${p.focus ? ` focus ${name(p.focus)}` : ''}`);
}

export default class BorshevikWorkspaceManager extends Extension {
    enable() {
        this.initTranslations();
        this._settings = this.getSettings();
        const updateLog = () => setLogging(this._settings.get_boolean('debug-logging'));
        updateLog();
        this._logHandle = this._settings.connect('changed::debug-logging', updateLog);

        this._intents = [];
        this._dispatching = false;
        this._enabled = true;
        const dispatch = intent => this.dispatch(intent);

        this._registry = new Registry();
        this._rules = new WindowRules({ settings: this._settings, registry: this._registry });
        this._executor = new Executor({
            registry: this._registry, settings: this._settings,
            onSettled: (win, width) => dispatch({ type: 'settled', win, width }),
        });
        this._drag = new DragController({ registry: this._registry, rules: this._rules, dispatch });
        this._windows = new WindowTracker({
            registry: this._registry, rules: this._rules, executor: this._executor, dispatch,
            settings: this._settings, isDragging: win => this._drag.isDragging(win),
        });
        this._drag._windows = this._windows;
        this._android = new AndroidWindows({ registry: this._registry, windows: this._windows, rules: this._rules, dispatch });
        this._windows.android = this._android;
        this._drag.android = this._android;
        this._indicator = new Indicator({ registry: this._registry, isRelevant: w => this._windows.isRelevant(w), path: this.path });

        // Mutter's own edge tiling and Super+Left/Right would race the extension's: off while enabled
        this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
        this._savedEdgeTiling = this._mutterSettings.get_boolean('edge-tiling');
        this._mutterSettings.set_boolean('edge-tiling', false);
        this._mutterKbSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter.keybindings' });
        this._savedTileLeft = this._mutterKbSettings.get_strv('toggle-tiled-left');
        this._savedTileRight = this._mutterKbSettings.get_strv('toggle-tiled-right');
        this._mutterKbSettings.set_strv('toggle-tiled-left', []);
        this._mutterKbSettings.set_strv('toggle-tiled-right', []);

        Main.wm.addKeybinding('tile-left', this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._drag.tileKeyboard('left'));
        Main.wm.addKeybinding('tile-right', this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._drag.tileKeyboard('right'));
        Main.wm.addKeybinding('open-rules-ui', this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._rulesUI.toggle());
        this._rulesUI = new WindowRulesUI(this);

        this._drag.enable();
        this._windows.enable();
        this._indicator.enable();
        this._windows.adoptExisting();
        LOG('enabled');
    }

    disable() {
        this._enabled = false;
        this._intents = [];
        Main.wm.removeKeybinding('tile-left');
        Main.wm.removeKeybinding('tile-right');
        Main.wm.removeKeybinding('open-rules-ui');
        this._rulesUI.close();
        this._rulesUI = null;
        this._indicator.disable();
        this._windows.disable();
        this._drag.disable();
        this._android.disable();
        this._executor.destroy();
        this._registry.clear();

        this._mutterSettings.set_boolean('edge-tiling', this._savedEdgeTiling);
        this._mutterKbSettings.set_strv('toggle-tiled-left', this._savedTileLeft);
        this._mutterKbSettings.set_strv('toggle-tiled-right', this._savedTileRight);
        this._mutterSettings = this._mutterKbSettings = null;

        this._settings.disconnect(this._logHandle);
        this._settings = null;
        this._indicator = this._windows = this._drag = this._android = this._executor = null;
        this._registry = this._rules = null;
    }

    // The one way anything gets placed: in order, one intent at a time, at idle, each plan
    // carried out to its end before the next intent is planned.
    dispatch(intent) {
        if (!this._enabled) return;
        LOG('dispatch: queued', intent.type, intent.win ? name(intent.win) : '');
        this._intents.push(intent);
        this._next();
    }

    _next() {
        if (this._dispatching || !this._intents.length) return;
        this._dispatching = true;
        global.compositor.get_laters().add(Meta.LaterType.IDLE, () => {
            if (!this._enabled) return false;
            const intent = this._intents.shift();
            let p = null;
            try {
                const floatSizes = (() => {
                    try { return JSON.parse(this._settings.get_string('float-sizes')); } catch { return {}; }
                })();
                const opening = intent.type === 'opened' ? intent.wins : [];
                const snapshot = take(this._registry, floatSizes, opening);
                p = plan(snapshot, intent);
                for (const w of opening) {
                    const rec = this._registry.get(w);
                    if (rec) rec.placed = true;
                }
                LOG('dispatch:', intent.type, intent.win ? name(intent.win) : '', '→',
                    p.ops.map(o => o.op).join(' ') || 'nothing', p.activate ? '+ show' : '');
                if (logging() && (intent.type !== 'recheck' || p.ops.length))
                    logPlan(snapshot, intent, p);
            } catch (e) {
                LOG('dispatch: planning failed', intent.type, e.message, e.stack);
            }
            const after = () => {
                // guests covered by what the plan did are found once its windows have settled
                if (intent.type !== 'recheck') {
                    for (const ws of p?.touched ?? []) {
                        if (ws && !ws.newWorkspace && ws.index?.() >= 0) this._intents.push({ type: 'recheck', ws });
                    }
                }
                this._dispatching = false;
                this._next();
            };
            if (p && p.ops.length + (p.activate ? 1 : 0) > 0) {
                try {
                    this._executor.run(p, after);
                } catch (e) {
                    LOG('dispatch: executing failed', e.message, e.stack);
                    after();
                }
            } else {
                after();
            }
            return false;
        });
    }

    // ── for rules-ui ─────────────────────────────────────────────────────────

    _isRelevant(win) {
        return this._windows.isRelevant(win);
    }

    _applyRuleToAll(rule) {
        this._rules.applyToAll(rule);
    }

    _appliedRules(win) {
        return this._rules.appliedTo(win);
    }

    _defer(fn) {
        global.compositor.get_laters().add(Meta.LaterType.IDLE, () => { fn(); return false; });
    }
}
