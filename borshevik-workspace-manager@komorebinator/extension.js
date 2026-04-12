/* extension.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Clutter from 'gi://Clutter';
import GLib  from 'gi://GLib';
import Meta  from 'gi://Meta';
import Shell from 'gi://Shell';
import St    from 'gi://St';
import Gio   from 'gi://Gio';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WindowRulesUI } from './window-rules-ui.js';

let   LOG    = () => {};
const SNAP_PX         = 32;
const DRAG_THRESHOLD  = 20;   // px cursor must travel before snap zones activate

// Window is managed by us if it has _bwmState set.
// State lives on the window object itself — survives workspace index shifts,
// workspace-changed signals, and enable/disable cycles.
//
// win._bwmState      'floating' | 'tiled-left' | 'tiled-right' | 'maximized'
// win._bwmFloatRect  { x, y, width, height } | undefined  — saved pre-tile geometry
// win._bwmPreMax     string | undefined  — state before maximize, for restore
// win._bwmPendingGeom { x, y, w, h } | undefined  — queued geometry before first-frame
// win._bwmFirstFrame bool — has first buffer commit fired
// win._bwmHandled    bool — passed through handleNewWindow (batch dedup)
// win._bwmMoving        bool      — we initiated a workspace change (skip auto-tile)
// win._bwmJustMoved     bool      — user manually moved to this ws (skip coverage check once)
// win._bwmOrigin        { ws: MetaWorkspace, side?: string } | undefined  — original workspace (and slot) this window was moved from
// win._bwmAppliedRules  Set<uuid> — UUIDs of window rules applied at map time
// win._bwmForceNewWs    string    — rule id requesting window opens on a dedicated workspace

const isTracked = win => win._bwmState !== undefined;

export default class BorshevikWorkspaceManager extends Extension {

    constructor(metadata) {
        super(metadata);

        // Persistent across enable/disable cycles (e.g. screen lock/unlock).
        // Workspaces we created — MetaWorkspace OBJECTS, stable across index shifts.
        this._ourWorkspaces = new Set();

        // Move serialization queue
        this._moveQueue    = [];
        this._moveInFlight = false;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    enable() {
        this._settings = this.getSettings();

        const updateLog = () => {
            LOG = this._settings.get_boolean('debug-logging')
                ? (...a) => console.log('[BWM]', ...a) : () => {};
        };
        updateLog();
        // Debounce timer for restacked signal (fires very frequently)
        this._restackedTimer = null;

        // Batch processing for auto-tile: collect windows mapping within 150ms,
        // process together so Chrome "restore session" windows settle before placement.
        this._pendingBatch = new Set();
        this._batchTimer   = null;
        this._currentBatch = null;

        // Move-drag state
        this._drag       = null;   // { win, monitor, startX, startY, tiledSide }
        this._dragPollId = null;
        this._snapSide   = null;

        // Linked-resize state
        this._resize = null;       // { win, partner }

        // Snap preview — reuse GNOME's tile-preview CSS for free accent-colour theming
        this._preview = new St.Widget({ style_class: 'tile-preview', visible: false });
        Main.layoutManager.uiGroup.add_child(this._preview);

        // Disable GNOME edge-tiling so it doesn't race with ours
        this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
        this._savedEdgeTiling = this._mutterSettings.get_boolean('edge-tiling');
        this._mutterSettings.set_boolean('edge-tiling', false);

        // Override Super+Left / Super+Right with our own tile logic
        this._mutterKbSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter.keybindings' });
        this._savedTileLeft    = this._mutterKbSettings.get_strv('toggle-tiled-left');
        this._savedTileRight   = this._mutterKbSettings.get_strv('toggle-tiled-right');
        this._mutterKbSettings.set_strv('toggle-tiled-left',  []);
        this._mutterKbSettings.set_strv('toggle-tiled-right', []);

        Main.wm.addKeybinding('tile-left',  this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._tileKeyboard('left'));
        Main.wm.addKeybinding('tile-right', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._tileKeyboard('right'));
        Main.wm.addKeybinding('open-rules-ui', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._rulesUI.toggle());

        this._rulesUI = new WindowRulesUI(this);

        this._handles = [
            [global.display,           global.display.connect('window-created', (_, win) => this._onWindowCreated(win))],
            [global.display,           global.display.connect('grab-op-begin', (_, w, op) => this._onGrabBegin(w, op))],
            [global.display,           global.display.connect('grab-op-end',   (_, w, op) => this._onGrabEnd(w, op))],
            [global.display,           global.display.connect('restacked', () => this._onRestacked())],
            [this._settings,           this._settings.connect('changed::debug-logging', updateLog)],
            // Indicator signals
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => this._scheduleIndicatorUpdate())],
            [global.workspace_manager, global.workspace_manager.connect('workspace-added',          () => this._scheduleIndicatorUpdate())],
            [global.workspace_manager, global.workspace_manager.connect('workspaces-reordered',     () => this._scheduleIndicatorUpdate())],
            [Shell.WindowTracker.get_default(), Shell.WindowTracker.get_default().connect('tracked-windows-changed', () => this._scheduleIndicatorUpdate())],
        ];

        // Panel indicator — replaces the default activities/workspace dots
        this._indicatorTimer = null;
        Main.panel.statusArea['activities']?.hide();
        this._indicator = new St.BoxLayout({ style_class: 'bwm-indicator' });
        Main.panel._leftBox.insert_child_at_index(this._indicator, 0);

        this._scheduleIndicatorUpdate();
        this._adoptExistingWindows();
    }

    disable() {
        this._handles.splice(0).forEach(([obj, id]) => obj.disconnect(id));

        if (this._dragPollId) {
            GLib.source_remove(this._dragPollId);
            this._dragPollId = null;
        }
        this._drag = null;

        if (this._batchTimer) {
            GLib.source_remove(this._batchTimer);
            this._batchTimer = null;
        }
        this._pendingBatch.clear(); this._pendingBatch = null;

        if (this._restackedTimer) {
            GLib.source_remove(this._restackedTimer);
            this._restackedTimer = null;
        }

        if (this._indicatorTimer) {
            GLib.source_remove(this._indicatorTimer);
            this._indicatorTimer = null;
        }
        this._rulesUI.close();
        this._rulesUI = null;

        this._indicator.destroy();
        this._indicator = null;
        Main.panel.statusArea['activities']?.show();

        this._preview.destroy();
        this._preview = null;

        this._mutterSettings.set_boolean('edge-tiling', this._savedEdgeTiling);
        this._mutterSettings = null;

        Main.wm.removeKeybinding('tile-left');
        Main.wm.removeKeybinding('tile-right');
        Main.wm.removeKeybinding('open-rules-ui');
        this._mutterKbSettings.set_strv('toggle-tiled-left',  this._savedTileLeft);
        this._mutterKbSettings.set_strv('toggle-tiled-right', this._savedTileRight);
        this._mutterKbSettings = null;

        this._settings = null;
    }

    // ── Panel indicator ──────────────────────────────────────────────────────

    _scheduleIndicatorUpdate() {
        if (this._indicatorTimer) return;
        this._indicatorTimer = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._indicatorTimer = null;
            this._updateIndicator();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateIndicator() {
        this._indicator.destroy_all_children();
        const wm      = global.workspace_manager;
        const nWs     = wm.get_n_workspaces();
        const activeI = wm.get_active_workspace_index();
        const tracker = Shell.WindowTracker.get_default();
        const ICON    = 22;

        // Logo button
        const logoPath = this.path + '/bwm_icon.svg';
        const logoBtn = new St.Button({
            style_class: 'bwm-logo-btn', reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        logoBtn.set_y_expand(false);
        const logoIcon = new St.Icon({ gicon: Gio.icon_new_for_string(logoPath), icon_size: 22 });
        logoIcon.opacity = 204; // 80%
        logoBtn.set_child(logoIcon);
        logoBtn.connect('enter-event', () => { logoIcon.opacity = 255; });
        logoBtn.connect('leave-event', () => { logoIcon.opacity = 204; });
        logoBtn.connect('clicked', () => Main.overview.toggle());
        this._indicator.add_child(logoBtn);

        for (let i = 0; i < nWs; i++) {
            const ws = wm.get_workspace_by_index(i);
            const winOrder = w => w.fullscreen ? 0 : w._bwmState === 'maximized' ? 1
                                : w._bwmState === 'tiled-left' ? 2 : w._bwmState === 'tiled-right' ? 3 : 4;
            const wins = ws.list_windows()
                .filter(w => this._isRelevant(w) && !w.on_all_workspaces && !w.skip_pager && w.get_workspace() === ws)
                .sort((a, b) => winOrder(a) - winOrder(b));

            const isLast = i === nWs - 1 && wins.length === 0;

            if (wins.length === 0 && !isLast && (i !== activeI || nWs === 1)) continue;
            if (wins.length === 0 && nWs === 1) continue;

            const isActive = i === activeI;
            const btn = new St.Button({
                style_class: 'bwm-ws',
                reactive: true,
                y_align: Clutter.ActorAlign.FILL,
                opacity: isActive ? 255 : 204,
            });
            btn.set_y_expand(true);
            btn.connect('clicked', () => ws.activate(global.get_current_time()));

            const row = new St.BoxLayout({ style_class: 'bwm-ws-row' });
            row.add_child(new St.Label({ text: `${i + 1}`, style_class: 'bwm-ws-num', y_align: Clutter.ActorAlign.CENTER }));

            if (isLast) {
                row.add_child(new St.Icon({ icon_name: 'list-add-symbolic', icon_size: 14, style_class: 'bwm-ws-plus', y_align: Clutter.ActorAlign.CENTER }));
            } else {
                for (const win of wins) {
                    const app = tracker.get_window_app(win);
                    if (!app) continue;
                    const icon = app.create_icon_texture(ICON);
                    icon.style_class = 'bwm-app-icon';
                    if (!isActive)
                        icon.add_effect(new Clutter.DesaturateEffect({ factor: 1.0 }));
                    row.add_child(icon);
                }
            }

            const bg = new St.Bin({
                style_class: isActive ? 'bwm-ws-bg bwm-ws-active' : 'bwm-ws-bg',
                child: row,
            });
            btn.set_child(bg);

            // ── Drag-to-reorder ───────────────────────────────────────────────
            btn._bwmWs = ws;
            btn._bwmBg = bg;

            btn.connect('button-press-event', (_actor, event) => {
                if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
                const [startX, startY] = event.get_coords();
                let activeDrag = false;
                let clone = null;

                const captureId = global.stage.connect('captured-event', (_stage, ev) => {
                    const type = ev.type();

                    if (type === Clutter.EventType.MOTION) {
                        const [cx, cy] = ev.get_coords();
                        if (!activeDrag) {
                            if (Math.hypot(cx - startX, cy - startY) < 6)
                                return Clutter.EVENT_PROPAGATE;
                            activeDrag = true;
                            const [bx, by] = bg.get_transformed_position();
                            clone = new Clutter.Clone({ source: bg });
                            clone.set_position(bx, by);
                            Main.layoutManager.uiGroup.add_child(clone);
                            bg.opacity = 80;
                        }
                        clone.set_x(cx - clone.width / 2);
                        this._updateWsDragTarget(cx, ws);
                        return Clutter.EVENT_PROPAGATE;
                    }

                    if (type === Clutter.EventType.BUTTON_RELEASE) {
                        global.stage.disconnect(captureId);
                        if (!activeDrag) return Clutter.EVENT_PROPAGATE;
                        clone.destroy();
                        bg.opacity = 255;
                        this._commitWsDrop(ws, isLast);
                        return Clutter.EVENT_STOP;
                    }

                    if (type === Clutter.EventType.KEY_PRESS &&
                        ev.get_key_symbol() === Clutter.KEY_Escape) {
                        global.stage.disconnect(captureId);
                        if (activeDrag) {
                            clone.destroy();
                            bg.opacity = 255;
                            this._wsDragTarget?._bwmBg.remove_style_class_name('bwm-ws-drag-over');
                            this._wsDragTarget = null;
                        }
                        return Clutter.EVENT_STOP;
                    }

                    return Clutter.EVENT_PROPAGATE;
                });

                return Clutter.EVENT_PROPAGATE;
            });
            // ─────────────────────────────────────────────────────────────────

            this._indicator.add_child(btn);
        }
    }

    _updateWsDragTarget(cx, srcWs) {
        let found = null;
        for (const child of this._indicator.get_children()) {
            if (!child._bwmWs || child._bwmWs === srcWs) continue;
            const [ax] = child.get_transformed_position();
            if (cx >= ax && cx < ax + child.width) { found = child; break; }
        }
        if (this._wsDragTarget !== found) {
            this._wsDragTarget?._bwmBg.remove_style_class_name('bwm-ws-drag-over');
            this._wsDragTarget = found;
            found?._bwmBg.add_style_class_name('bwm-ws-drag-over');
        }
    }

    _commitWsDrop(srcWs, activate = false) {
        const target = this._wsDragTarget;
        this._wsDragTarget?._bwmBg.remove_style_class_name('bwm-ws-drag-over');
        this._wsDragTarget = null;
        if (!target) return;
        global.workspace_manager.reorder_workspace(srcWs, target._bwmWs.index());
        if (activate)
            srcWs.activate(global.get_current_time());
    }

    // ── Window rules ─────────────────────────────────────────────────────────

    _applyWindowRules(win) {
        let rules;
        try   { rules = JSON.parse(this._settings.get_string('window-rules')); }
        catch { return; }
        if (!rules.length) return;

        win._bwmAppliedRules = new Set();
        for (const rule of rules)
            this._applyRule(win, rule);
    }

    // Apply one rule to all currently tracked windows (called from UI on save).
    _applyRuleToAll(rule) {
        const manager = global.workspace_manager;
        for (let i = 0; i < manager.get_n_workspaces(); i++)
            for (const win of manager.get_workspace_by_index(i).list_windows())
                if (isTracked(win)) this._applyRule(win, rule);
    }

    _matchesRule(win, rule) {
        const c = rule.conditions;
        if (c.class?.enabled) {
            try { if (!new RegExp(c.class.regex).test(win.get_wm_class() ?? '')) return false; }
            catch { return false; }
        }
        if (c.title?.enabled) {
            try { if (!new RegExp(c.title.regex).test(win.get_title() ?? '')) return false; }
            catch { return false; }
        }
        if (c.onAllWorkspaces?.enabled && !win.is_on_all_workspaces()) return false;
        if (c.above?.enabled           && !win.above)                         return false;
        if (c.skipTaskbar?.enabled     && !win.skip_taskbar)                  return false;
        if (c.fullscreen?.enabled      && !win.fullscreen)                    return false;
        if (c.maximized?.enabled       && !(win.maximized_horizontally && win.maximized_vertically)) return false;
        return true;
    }

    _applyRule(win, rule) {
        if (!this._matchesRule(win, rule)) return;
        const a = rule.actions;
        if (a.onAllWorkspaces?.enabled) {
            if (a.onAllWorkspaces.value) win.stick();
            else win.unstick();
        }
        if (a.above?.enabled) {
            if (a.above.value) win.make_above();
            else win.unmake_above();
        }
        if (a.openOnNewWorkspace?.enabled && a.openOnNewWorkspace.value && !win._bwmFirstFrame)
            win._bwmForceNewWs = rule.id;
        if (a.geometry?.enabled) {
            const wa = win.get_work_area_current_monitor();
            const x  = Math.round(wa.x + wa.width  * a.geometry.x / 100);
            const y  = Math.round(wa.y + wa.height * a.geometry.y / 100);
            const w  = Math.round(wa.width  * a.geometry.w / 100);
            const h  = Math.round(wa.height * a.geometry.h / 100);
            if (win._bwmFirstFrame) {
                win.move_resize_frame(true, x, y, w, h);
            } else {
                win._bwmRuleGeom = { x, y, w, h };
            }
        }
        if (!win._bwmAppliedRules) win._bwmAppliedRules = new Set();
        win._bwmAppliedRules.add(rule.id);
    }

    // ── Small helpers ────────────────────────────────────────────────────────

    _isPrimary(mon) {
        return mon === Main.layoutManager.primaryIndex;
    }

    // After shell restart, some windows (e.g. Chrome web apps) reconnect to the
    // compositor without firing the `map` signal, so they're never processed by
    // handleNewWindow and remain untracked. This causes hasExisting to return false
    // for new windows opening on the same workspace. Adopt them on enable() so
    // they count as existing occupants without moving them.
    _adoptExistingWindows() {
        const wm = global.workspace_manager;
        for (let i = 0; i < wm.get_n_workspaces(); i++) {
            for (const win of wm.get_workspace_by_index(i).list_windows()) {
                if (!this._isRelevant(win) || isTracked(win)) continue;
                if (win.get_maximized() === Meta.MaximizeFlags.BOTH) {
                    win._bwmState  = 'maximized';
                    win._bwmPreMax = 'floating';
                } else {
                    win._bwmState = 'floating';
                    win._bwmFloatRect = this._toRect(win.get_frame_rect());
                }
                LOG('adopt:', win.get_wm_class(), '→', win._bwmState);
            }
        }
    }

    _isRelevant(win) {
        return win.window_type === Meta.WindowType.NORMAL &&
            !win.skip_taskbar &&
            !win.is_on_all_workspaces();
    }

    _defer(fn) {
        global.compositor.get_laters().add(Meta.LaterType.IDLE, () => { fn(); return false; });
    }

    _toRect(r) { return { x: r.x, y: r.y, width: r.width, height: r.height }; }

    _centredRect(wa, wr, hr) {
        const w = Math.round(wa.width  * wr);
        const h = Math.round(wa.height * hr);
        return { x: wa.x + Math.round((wa.width - w) / 2),
                 y: wa.y + Math.round((wa.height - h) / 2),
                 width: w, height: h };
    }

    // Capture float geometry from a floating window and persist it.
    // Called ONLY from manual tile actions: _tileKeyboard and _finalizeDrag.
    _captureAndSaveFloatGeom(win) {
        if (win._bwmState !== 'floating') return;
        const wa = win.get_work_area_current_monitor();
        const fr = win.get_frame_rect();
        win._bwmFloatRect = this._toRect(fr);
        const geom = { wr: fr.width / wa.width, hr: fr.height / wa.height };
        try {
            const map = JSON.parse(this._settings.get_string('float-sizes'));
            map[win.get_wm_class()] = geom;
            this._settings.set_string('float-sizes', JSON.stringify(map));
        } catch (_) {}
    }

    _loadFloatGeom(wmClass) {
        try {
            const map = JSON.parse(this._settings.get_string('float-sizes'));
            return map[wmClass] ?? null;
        } catch (_) { return null; }
    }

    // ── Layout helper (computed on demand) ──────────────────────────────────
    //
    // No _layouts Map. Layout is derived from live window state by scanning the
    // workspace's window list. Always correct by definition — no synchronization needed.

    _getLayout(workspace, monitor) {
        const wins = workspace.list_windows()
            .filter(w => w.get_monitor() === monitor && isTracked(w));
        const blocker = wins.find(w => w.fullscreen || w._bwmState === 'maximized') ?? null;
        return {
            left:  wins.find(w => w._bwmState === 'tiled-left')  ?? blocker,
            right: wins.find(w => w._bwmState === 'tiled-right') ?? blocker,
        };
    }

    // ── Window signals ───────────────────────────────────────────────────────

    _onWindowCreated(win) {
        LOG('window-created:', win.get_wm_class(), `type=${win.window_type} skip=${win.skip_taskbar}`);
        if (!this._isRelevant(win)) return;
        if (isTracked(win)) return;

        const attach = () => {
            const actor = win.get_compositor_private();
            if (!actor) return;
            const id = actor.connect('first-frame', () => {
                actor.disconnect(id);
                if (isTracked(win)) return; // already registered (e.g. via grab-op)
                this._registerWindow(win);
            });
        };

        const actor = win.get_compositor_private();
        if (actor) {
            attach();
        } else {
            const notifyId = win.connect('notify::compositor-private', () => {
                win.disconnect(notifyId);
                attach();
            });
        }
    }

    _registerWindow(win) {
        const r0 = win.get_frame_rect();
        LOG('register:', win.get_wm_class(),
            `ws=${win.get_workspace()?.index()} mon=${win.get_monitor()}`,
            `max=${win.maximized_horizontally && win.maximized_vertically}`,
            `fs=${win.fullscreen}`,
            `size=${r0.width}x${r0.height}`);

        // Initialise state on the window object itself
        win._bwmState        = 'floating';
        win._bwmPreMax       = undefined;
        win._bwmFloatRect    = undefined;
        win._bwmPendingGeom  = undefined;
        win._bwmFirstFrame   = true;   // first-frame already fired — apply geometry immediately
        win._bwmHandled      = false;
        win._bwmAppliedRules = new Set();

        this._applyWindowRules(win);

        // Seed _bwmFloatRect from saved geometry if available.
        // Only store the actual floating size — never the maximized rect.
        if (!win.fullscreen) {
            const wa0   = win.get_work_area_current_monitor();
            const saved = this._loadFloatGeom(win.get_wm_class());
            if (saved) {
                win._bwmFloatRect = this._centredRect(wa0, saved.wr, saved.hr);
            } else if (!(win.maximized_horizontally && win.maximized_vertically)) {
                win._bwmFloatRect = this._toRect(r0);
            }
            // else: opened maximized with no saved geometry — _bwmFloatRect stays undefined
        }

        // Apply rule geometry immediately (first-frame already fired)
        if (win._bwmRuleGeom) {
            const { x, y, w, h } = win._bwmRuleGeom;
            win._bwmRuleGeom = undefined;
            LOG('register: applying rule geometry for', win.get_wm_class());
            win.move_resize_frame(true, x, y, w, h);
        }

        win.connect('unmanaged',         () => this._onUnmanaged(win));
        win.connect('workspace-changed', () => this._onWorkspaceChanged(win));
        win.connect('notify::maximized-horizontally', () => this._onMaximizeChange(win));
        win.connect('notify::maximized-vertically',   () => this._onMaximizeChange(win));
        win.connect('notify::fullscreen',             () => this._onMaximizeChange(win));

        this._pendingBatch.add(win);
        this._scheduleBatch();
    }

    _scheduleBatch() {
        if (this._batchTimer) return;
        this._batchTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._batchTimer = null;
            this._flushBatch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushBatch() {
        const wins = [...this._pendingBatch];
        this._pendingBatch.clear();
        this._currentBatch = new Set(wins);
        LOG(`flushBatch: ${wins.length} window(s)`);
        for (const win of wins) {
            if (isTracked(win))
                this._handleNewWindow(win);
        }
        this._currentBatch = null;
    }

    _onUnmanaged(win) {
        if (!isTracked(win)) return;
        LOG('unmanaged:', win.get_wm_class());

        const freedSide = win._bwmState === 'tiled-left'  ? 'left'
                        : win._bwmState === 'tiled-right' ? 'right' : null;
        const freedWs  = win._bwmTiledWs ?? win.get_workspace();
        const freedMon = win._bwmTiledMon ?? win.get_monitor();

        // Clear all extension state from the window
        delete win._bwmState;
        delete win._bwmFloatRect;
        delete win._bwmPreMax;
        delete win._bwmPendingGeom;
        delete win._bwmFirstFrame;
        delete win._bwmHandled;
        delete win._bwmMoving;
        delete win._bwmJustMoved;
        delete win._bwmOrigin;
        delete win._bwmTiledWs;
        delete win._bwmTiledMon;
        delete win._bwmAppliedRules;
        delete win._bwmForceNewWs;
        delete win._bwmRuleGeom;

        this._pendingBatch?.delete(win);

        if (freedSide && freedWs && freedMon >= 0)
            this._defer(() => this._tryReturnOrigin(freedWs, freedSide, freedMon));
    }

    _leaveIfEmpty(ws) {
        LOG('leaveIfEmpty called: ws', ws?.index(), 'isOurs=', this._ourWorkspaces.has(ws), 'active=', global.workspace_manager.get_active_workspace()?.index());
        if (!this._ourWorkspaces.has(ws)) return;
        const wsIdx = ws.index();
        if (wsIdx < 0) return; // workspace already removed

        const manager = global.workspace_manager;
        if (manager.get_active_workspace() !== ws) return; // user moved away already

        const hasWindows = ws.list_windows()
            .some(w => !w.is_on_all_workspaces() && this._isRelevant(w));
        if (hasWindows) return;

        let target = manager.get_workspace_by_index(wsIdx - 1);
        if (!target) {
            // Leftmost workspace — try right if it has windows
            const right = manager.get_workspace_by_index(wsIdx + 1);
            if (!right) return;
            const rightHasWindows = right.list_windows()
                .some(w => !w.is_on_all_workspaces() && this._isRelevant(w));
            if (!rightHasWindows) return;
            target = right;
        }

        LOG('leaveIfEmpty: ws', wsIdx, '→ ws', target.index(), '(our workspace, now empty)');
        this._ourWorkspaces.delete(ws);
        target.activate(global.get_current_time());
    }

    _onWorkspaceChanged(win) {
        if (!isTracked(win)) return;
        const newWs = win.get_workspace();
        if (!newWs) return; // being unmanaged — ignore

        // State lives on the window — no reset needed here.
        // This signal fires for both real moves AND workspace index shifts (when any
        // workspace is added/removed). We do NOT touch state in either case.

        if (win._bwmMoving) return; // system-initiated move — caller handles placement

        // User manually moved the window — raise and check for free tile slot
        LOG('workspace-changed (user):', win.get_wm_class(), '→ ws', newWs.index());
        win.raise();
        win._bwmJustMoved = true;
        const prevSide = win._bwmState === 'tiled-left'  ? 'left'
                       : win._bwmState === 'tiled-right' ? 'right' : null;
        const oldWs    = win._bwmTiledWs ?? null;
        const prevMon  = win.get_monitor();
        delete win._bwmOrigin; // user chose a new home — cancel auto-return
        if (prevSide && oldWs && oldWs !== newWs && prevMon >= 0)
            this._defer(() => this._tryReturnOrigin(oldWs, prevSide, prevMon));
        this._defer(() => this._tileIntoFreeSlot(win));
    }

    _onMaximizeChange(win) {
        if (!isTracked(win)) return;

        const full = win.fullscreen || (win.maximized_horizontally && win.maximized_vertically);
        LOG('onMaximizeChange:', win.get_wm_class(), `full=${full} state=${win._bwmState}`);

        // State-based dedup: both notify::maximized-h and notify::maximized-v fire for one op.
        // Also suppresses re-entrant calls when WE call maximize/unmaximize — state is
        // always set BEFORE calling the Mutter API so this guard catches the resulting notify.
        if (full === (win._bwmState === 'maximized')) return;

        if (full) {
            // NOTE: do NOT update _bwmFloatRect here — the window is already maximized
            // when this signal fires, so get_frame_rect() returns the maximized rect.
            // The correct float rect is already in _bwmFloatRect from _registerWindow or _doFloat.
            win._bwmPreMax  = win._bwmState;
            win._bwmState   = 'maximized'; // must be set BEFORE any async ops to suppress re-entry
            LOG('→ maximized:', win.get_wm_class(), 'from', win._bwmPreMax);

            const ws  = win.get_workspace();
            const mon = win.get_monitor();
            if (ws && this._isPrimary(mon) && this._hasOtherWindows(ws, mon, win)) {
                if (!win._bwmOrigin) win._bwmOrigin = { ws };
                this._defer(() => this._moveToNewWorkspace(win));
            }
        } else {
            this._onUnmaximized(win);
        }
    }

    _onUnmaximized(win) {
        const prev     = win._bwmPreMax ?? 'floating';
        win._bwmPreMax = undefined;

        // During drag: Mutter auto-unmaximizes on drag start.
        // Don't schedule re-tile; let _finalizeDrag handle the final state.
        if (this._drag?.win === win) {
            LOG('← unmaximized during drag:', win.get_wm_class(), '(skipping restore, was', prev, ')');
            win._bwmState = 'floating';
            return;
        }

        LOG('← unmaximized:', win.get_wm_class(), 'restoring', prev);

        // If window has an origin workspace, try to return there.
        const originWs = win._bwmOrigin?.ws ?? null;
        delete win._bwmOrigin;
        if (originWs) {
            const currentWs = win.get_workspace();
            const mon       = win.get_monitor();
            const hasFullscreen = originWs.list_windows().some(w =>
                w.get_monitor() === mon && w.fullscreen);
            if (!hasFullscreen) {
                const originLayout = this._getLayout(originWs, mon);
                let targetSide = null;
                if      (prev === 'tiled-left'  && !originLayout.left)  targetSide = 'left';
                else if (prev === 'tiled-right' && !originLayout.right) targetSide = 'right';

                if (targetSide) {
                    LOG('← unmaximized: returning to ws', originWs.index(), 'side', targetSide);
                    win._bwmMoving = true;
                    win._bwmState  = `tiled-${targetSide}`;
                    win.change_workspace(originWs);
                    originWs.activate(global.get_current_time());
                    this._defer(() => {
                        delete win._bwmMoving;
                        if (isTracked(win)) this._tileWindow(win, targetSide);
                    });
                    return;
                } else if (prev === 'floating' && currentWs !== originWs) {
                    LOG('← unmaximized: returning float to ws', originWs.index());
                    win._bwmState  = 'floating';
                    win._bwmMoving = true;
                    win.change_workspace(originWs);
                    originWs.activate(global.get_current_time());
                    this._defer(() => {
                        delete win._bwmMoving;
                        if (isTracked(win)) this._doFloat(win);
                    });
                    return;
                }
            }
        }

        // Default: restore to pre-maximize state on current workspace.
        if (prev === 'tiled-left' || prev === 'tiled-right') {
            const side   = prev === 'tiled-left' ? 'left' : 'right';
            const ws     = win.get_workspace();
            const mon    = win.get_monitor();
            const layout = ws ? this._getLayout(ws, mon) : { left: null, right: null };

            if (!layout[side] || layout[side] === win) {
                // Slot is free — set state immediately so any second notify is suppressed,
                // then defer the geometry application.
                win._bwmState = `tiled-${side}`;
                this._defer(() => {
                    if (isTracked(win)) this._tileWindow(win, side);
                });
            } else {
                // Slot is taken — fall back to float
                LOG('← unmaximized: slot', side, 'taken by', layout[side]?.get_wm_class(), '— falling back to float');
                win._bwmState = 'floating';
                this._defer(() => { if (isTracked(win)) this._doFloat(win); });
            }
        } else {
            win._bwmState = 'floating';
            this._defer(() => { if (isTracked(win)) this._doFloat(win); });
        }
    }

    // ── Grab-op: drag & resize ───────────────────────────────────────────────

    _onGrabBegin(win, op) {
        LOG('grab-op-begin:', win?.get_wm_class() ?? 'null', `op=${op}`, `tracked=${!!win && isTracked(win)}`);

        // Chrome tab-detach creates a window that never fires `map` on Wayland.
        // Register it here so drag-to-snap works normally.
        if (win && !isTracked(win) && this._isRelevant(win)) {
            LOG('grab-op-begin: late-registering', win.get_wm_class());
            win._bwmState      = 'floating';
            win._bwmPreMax     = undefined;
            win._bwmFloatRect  = undefined;
            win._bwmFirstFrame = true;
            win._bwmHandled    = false;
            win.connect('unmanaged',         () => this._onUnmanaged(win));
            win.connect('workspace-changed', () => this._onWorkspaceChanged(win));
            win.connect('notify::maximized-horizontally', () => this._onMaximizeChange(win));
            win.connect('notify::maximized-vertically',   () => this._onMaximizeChange(win));
            win.connect('notify::fullscreen',             () => this._onMaximizeChange(win));
        }
        if (!win || !isTracked(win)) return;

        if (op === Meta.GrabOp.MOVING) {
            LOG('drag-begin:', win.get_wm_class());

            // Set _drag FIRST — before any window ops that might trigger notify::maximized-*.
            // Mutter auto-unmaximizes on drag start; our _onUnmaximized guard checks _drag.
            const [startX, startY] = global.get_pointer();
            this._drag = { win, monitor: win.get_monitor(), startX, startY, tiledSide: null };

            if (win._bwmState === 'tiled-left' || win._bwmState === 'tiled-right') {
                this._drag.tiledSide = win._bwmState === 'tiled-left' ? 'left' : 'right';
                LOG('drag-begin: tiled-', this._drag.tiledSide, '— will detach at threshold');
            }

            this._dragPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
                if (!this._drag) return GLib.SOURCE_REMOVE;
                this._pollDrag();
                return GLib.SOURCE_CONTINUE;
            });
            return;
        }

        // Resize — only care about tiled windows
        if (!win._bwmState?.startsWith('tiled')) return;
        const ws      = win.get_workspace();
        if (!ws) return;
        const layout  = this._getLayout(ws, win.get_monitor());
        const partner = layout.left === win ? layout.right : layout.left;
        if (!partner?._bwmState?.startsWith('tiled')) return;
        LOG('resize-begin:', win.get_wm_class(), '| partner:', partner.get_wm_class());
        this._resize = { win, partner };
    }

    _onGrabEnd(win, _op) {
        if (this._drag?.win === win) {
            GLib.source_remove(this._dragPollId);
            this._dragPollId = null;
            this._finalizeDrag(win);
            this._drag     = null;
            this._hidePreview();
            this._snapSide = null;
        }

        if (this._resize?.win === win) {
            this._finalizeResize();
            this._resize = null;
        }
    }

    _pollDrag() {
        const win = this._drag?.win;
        if (!win) return;
        const [cx, cy] = global.get_pointer();

        // Track which monitor the cursor is on
        let monIdx = 0;
        for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
            const m = Main.layoutManager.monitors[i];
            if (cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height) {
                monIdx = i; break;
            }
        }
        this._drag.monitor = monIdx;

        const wa   = win.get_work_area_for_monitor(monIdx);
        let   snap = null;
        const dist = Math.hypot(cx - this._drag.startX, cy - this._drag.startY);
        if (dist >= DRAG_THRESHOLD) {
            // Lazy detach: first time we cross the threshold for a tiled window, untile it now.
            if (this._drag.tiledSide !== null) {
                if (win._bwmState === 'tiled-left' || win._bwmState === 'tiled-right') {
                    LOG('drag: threshold crossed — detaching tile', win.get_wm_class());
                    win._bwmState = 'floating';
                    const saved = this._loadFloatGeom(win.get_wm_class());
                    if (saved) {
                        const cur = win.get_frame_rect();
                        win.move_resize_frame(false, cur.x, cur.y,
                            Math.round(wa.width * saved.wr), Math.round(wa.height * saved.hr));
                    }
                }
                const detachedSide = this._drag.tiledSide;
                const ws           = win.get_workspace();
                const mon          = this._drag.monitor;
                this._drag.tiledSide = null;
                if (ws && mon >= 0)
                    this._defer(() => this._tryReturnOrigin(ws, detachedSide, mon));
                this._floatReturnToOrigin(win, ws, mon);
            } else if (!this._drag.originReturned) {
                this._drag.originReturned = true;
                const ws  = win.get_workspace();
                const mon = this._drag.monitor;
                this._floatReturnToOrigin(win, ws, mon);
            }
            if      (cx <= wa.x + SNAP_PX)              snap = 'left';
            else if (cx >= wa.x + wa.width - SNAP_PX)   snap = 'right';
            else if (cy <= wa.y + SNAP_PX)               snap = 'maximize';
        }

        if (snap !== this._snapSide) {
            this._snapSide = snap;
            LOG('snap-zone:', snap ?? 'none');
            snap ? this._showPreview(snap, wa) : this._hidePreview();
        }
    }

    // ── Preview ──────────────────────────────────────────────────────────────

    _showPreview(side, wa) {
        const half = Math.floor(wa.width / 2);
        const map  = {
            left:     [wa.x,        wa.y, half,            wa.height],
            right:    [wa.x + half, wa.y, wa.width - half, wa.height],
            maximize: [wa.x,        wa.y, wa.width,        wa.height],
        };
        const [x, y, w, h] = map[side];
        this._preview.set_position(x, y);
        this._preview.set_size(w, h);
        this._preview.show();
    }

    _hidePreview() { this._preview.hide(); }

    // ── Drag finalize ────────────────────────────────────────────────────────

    _finalizeDrag(win) {
        if (!isTracked(win)) return;

        if (!this._snapSide) {
            LOG('drag-end:', win.get_wm_class(), '(no snap)');
            return;
        }

        LOG('drag-end:', win.get_wm_class(), '→ snap', this._snapSide);

        if (this._snapSide === 'maximize') {
            this._doMaximize(win);
        } else {
            this._captureAndSaveFloatGeom(win);
            this._tileWindow(win, this._snapSide);
        }
    }

    // ── Resize finalize ──────────────────────────────────────────────────────

    _finalizeResize() {
        const { win, partner } = this._resize;
        if (!isTracked(win)) return;

        const wa   = win.get_work_area_current_monitor();
        const rect = win.get_frame_rect();
        let px, pw;

        if (win._bwmState === 'tiled-left') {
            px = rect.x + rect.width;
            pw = (wa.x + wa.width) - px;
        } else {
            px = wa.x;
            pw = rect.x - wa.x;
        }

        if (pw < 50) {
            LOG('resize-end: partner too narrow, skip');
            return;
        }

        LOG('resize-end:', win.get_wm_class(), '| partner', partner.get_wm_class(), `→ x=${px} w=${pw}`);
        partner.move_resize_frame(false, px, wa.y, pw, wa.height);
    }

    // ── Core window ops ──────────────────────────────────────────────────────

    /** Tile win to side. If target side is taken, displaces the occupant.
     *  overrideW sets a custom tile width (null = compute from partner or half screen). */
    _tileWindow(win, side, overrideW = null) {
        if (!isTracked(win)) return;
        const ws = win.get_workspace();
        if (!ws) return;
        const mon    = win.get_monitor();
        const wa     = win.get_work_area_current_monitor();
        const layout = this._getLayout(ws, mon);
        const other  = side === 'left' ? 'right' : 'left';

        win._bwmTiledWs  = ws;  // remember workspace so _onWorkspaceChanged can find it
        win._bwmTiledMon = mon; // remember monitor — get_monitor() returns -1 at unmanaged time

        LOG('tileWindow:', win.get_wm_class(), `→ ${side} state=${win._bwmState}`,
            `left=${layout.left?.get_wm_class() ?? '-'} right=${layout.right?.get_wm_class() ?? '-'}`);

        const occupant = (layout[side] && layout[side] !== win) ? layout[side] : null;

        if (occupant) {
            if (layout[other] && layout[other] !== win) {
                const occupantIsBlocker = occupant.fullscreen || occupant._bwmState === 'maximized';
                if (occupantIsBlocker) {
                    // Blocker occupies both slots — move win to new ws instead of displacing blocker.
                    if (!win._bwmOrigin) win._bwmOrigin = { ws };
                    this._moveToNewWorkspace(win, side, 'right');
                    return;
                }
                // Both sides occupied by tiles — displace the occupant of our target side.
                // After _displaceTile the occupant has moved workspace synchronously.
                // Re-read layout to get updated partner width for overrideW.
                this._displaceTile(occupant, side, mon);
                if (overrideW === null) {
                    const fresh = this._getLayout(ws, mon);
                    const p = fresh[other];
                    if (p && p !== win) {
                        const pw = p._bwmPendingGeom?.w ?? p.get_frame_rect().width;
                        overrideW = wa.width - pw;
                    }
                }
            } else {
                // Other side is free — swap occupant there.
                const occupantW = occupant.get_frame_rect().width;
                occupant._bwmState = `tiled-${other}`;
                this._doTile(occupant, other, wa, occupantW);
                overrideW = wa.width - occupantW;
            }
        } else if (overrideW === null) {
            // No occupant — fill space left by partner if present
            const partner = layout[other];
            if (partner && partner !== win) {
                const pw = partner._bwmPendingGeom?.w ?? partner.get_frame_rect().width;
                overrideW = wa.width - pw;
            }
        }

        // Set state BEFORE _doTile so the applyGeometry guard inside sees 'tiled-*',
        // and so any notify::maximized-* fired by unmaximize inside _doTile is suppressed
        // by the state check in _onMaximizeChange.
        win._bwmState = `tiled-${side}`;
        this._doTile(win, side, wa, overrideW);
        LOG('tile:', win.get_wm_class(), '→', side, overrideW !== null ? `w=${overrideW}` : '');
    }

    /** Raw geometry tile — no state or layout updates. */
    _doTile(win, side, wa = null, overrideW = null) {
        if (!wa) wa = win.get_work_area_current_monitor();
        const half = Math.floor(wa.width / 2);
        const w    = overrideW !== null ? overrideW : (side === 'left' ? half : wa.width - half);
        const x    = side === 'left' ? wa.x : wa.x + wa.width - w;

        const hadState = win.fullscreen || win.maximized_horizontally || win.maximized_vertically;

        const applyGeometry = () => {
            if (!isTracked(win)) return;
            if (!win._bwmState?.startsWith('tiled')) return;
            // Two-call pattern: some apps only resize but don't move on combined move_resize_frame.
            win.move_frame(true, x, wa.y);
            win.move_resize_frame(true, x, wa.y, w, wa.height);
        };

        if (hadState) {
            // Tell Mutter this is an unmaximize transition before touching the window.
            const actor = win.get_compositor_private();
            if (actor) {
                try {
                    Main.wm._prepareAnimationInfo(
                        global.window_manager, actor,
                        win.get_frame_rect().copy(),
                        Meta.SizeChange.UNMAXIMIZE);
                } catch {}
            }
            // win._bwmState is already 'tiled-*' (set by caller before _doTile),
            // so the resulting notify::maximized-* is suppressed by the state check.
            if (win.fullscreen)
                win.unmake_fullscreen();
            if (win.maximized_horizontally || win.maximized_vertically)
                win.unmaximize();
            applyGeometry();
            // Some apps (e.g. Chrome) process unmaximize asynchronously and restore
            // their pre-maximize position after we applied geometry. Re-apply once settled.
            let sigId = win.connect('size-changed', () => {
                win.disconnect(sigId);
                sigId = null;
                if (isTracked(win) && win._bwmState?.startsWith('tiled'))
                    applyGeometry();
            });
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                if (sigId !== null) { win.disconnect(sigId); sigId = null; }
                return GLib.SOURCE_REMOVE;
            });
        } else if (!win._bwmFirstFrame) {
            // Window hasn't drawn its first frame yet — move_resize_frame may be ignored.
            // Store the geometry; the first-frame handler in _onMap will apply it.
            LOG('_doTile: first-frame not yet fired, storing pending geometry for', win.get_wm_class());
            win._bwmPendingGeom = { x, y: wa.y, w, h: wa.height };
        } else {
            applyGeometry();
        }
    }

    _doMaximize(win) {
        if (!isTracked(win)) return;
        if (win._bwmState === 'maximized') return; // already maximized — don't corrupt preMaxState
        if (win._bwmState === 'floating')
            win._bwmFloatRect = this._toRect(win.get_frame_rect());
        win._bwmPreMax = win._bwmState;
        // Must set state BEFORE maximize() so the resulting notify is suppressed
        win._bwmState  = 'maximized';
        win.maximize();
        LOG('maximize:', win.get_wm_class(), 'preMaxState:', win._bwmPreMax);
        {
            const ws  = win.get_workspace();
            const mon = win.get_monitor();
            if (ws && this._isPrimary(mon) && this._hasOtherWindows(ws, mon, win)) {
                if (!win._bwmOrigin) win._bwmOrigin = { ws };
                this._defer(() => this._moveToNewWorkspace(win));
            }
        }
    }

    _doFloat(win) {
        if (!isTracked(win)) return;
        win._bwmState = 'floating';

        const wa    = win.get_work_area_current_monitor();
        const saved = this._loadFloatGeom(win.get_wm_class());

        if (win._bwmFloatRect) {
            const fr = win._bwmFloatRect;
            LOG('float:', win.get_wm_class(), `→ (${fr.x},${fr.y},${fr.width},${fr.height})`);
            win.move_frame(true, fr.x, fr.y);
            win.move_resize_frame(true, fr.x, fr.y, fr.width, fr.height);
        } else if (saved) {
            const fr = this._centredRect(wa, saved.wr, saved.hr);
            LOG('float(saved):', win.get_wm_class(), `→ (${fr.x},${fr.y},${fr.width},${fr.height})`);
            win._bwmFloatRect = fr;
            win.move_frame(true, fr.x, fr.y);
            win.move_resize_frame(true, fr.x, fr.y, fr.width, fr.height);
        } else {
            // No geometry — wait for window to report its natural size after unmaximize, then centre.
            let sigId = win.connect('size-changed', () => {
                win.disconnect(sigId);
                if (!isTracked(win)) return;
                const wa2 = win.get_work_area_current_monitor();
                const cur = win.get_frame_rect();
                const fr2 = this._centredRect(wa2, cur.width / wa2.width, cur.height / wa2.height);
                LOG('float(settle):', win.get_wm_class(), `→ (${fr2.x},${fr2.y},${fr2.width},${fr2.height})`);
                win._bwmFloatRect = fr2;
                win.move_frame(true, fr2.x, fr2.y);
                win.move_resize_frame(true, fr2.x, fr2.y, fr2.width, fr2.height);
            });
        }
    }

    // ── Auto-tile logic ──────────────────────────────────────────────────────

    /** Called when user manually moves a window to another workspace. */
    _tileIntoFreeSlot(win) {
        if (!isTracked(win)) return;
        if (this._drag?.win === win) return; // dragging — drag logic handles state
        const ws = win.get_workspace();
        if (!ws) return;
        const mon    = win.get_monitor();
        const layout = this._getLayout(ws, mon);

        // Already correctly placed
        if (win._bwmState === 'tiled-left'  && layout.left  === win) return;
        if (win._bwmState === 'tiled-right' && layout.right === win) return;

        if (!layout.left && !layout.right) {
            if      (win._bwmState === 'tiled-left')  this._tileWindow(win, 'left');
            else if (win._bwmState === 'tiled-right') this._tileWindow(win, 'right');
        } else if (layout.left && !layout.right) {
            this._tileWindow(win, 'right');
        } else if (!layout.left && layout.right) {
            this._tileWindow(win, 'left');
        } else {
            win._bwmState = 'floating'; // both slots taken
        }
        LOG('tileIntoFreeSlot:', win.get_wm_class(), '→', win._bwmState);
    }

    _handleNewWindow(win) {
        if (!isTracked(win)) return;
        win._bwmHandled = true;

        if (win._bwmForceNewWs) {
            const ruleId = win._bwmForceNewWs;
            delete win._bwmForceNewWs;
            if (this._isPrimary(win.get_monitor()))
                this._moveToRuleWorkspace(win, ruleId);
            return;
        }

        const ws  = win.get_workspace();
        if (!ws) return;
        const mon    = win.get_monitor();
        const layout = this._getLayout(ws, mon);

        const winIsBlocking = win.fullscreen ||
            (win.maximized_horizontally && win.maximized_vertically) ||
            win._bwmState === 'maximized';

        let hasExistingOther = false;
        for (const w of ws.list_windows()) {
            if (w === win) continue;
            if (!isTracked(w)) { LOG('hasExisting: skip (untracked)', w.get_wm_class()); continue; }
            if (w.get_monitor() !== mon) { LOG('hasExisting: skip (wrong mon)', w.get_wm_class()); continue; }
            if (w.is_on_all_workspaces()) { LOG('hasExisting: skip (allws)', w.get_wm_class()); continue; }
            if (!winIsBlocking && this._currentBatch?.has(w) && !w._bwmHandled) continue;
            LOG('hasExisting: COUNTED', w.get_wm_class(), 'sticky=', w.is_on_all_workspaces(), 'tracked=', isTracked(w));
            hasExistingOther = true;
            break;
        }

        const slotsUsed = (layout.left ? 1 : 0) + (layout.right ? 1 : 0);

        LOG('handleNewWindow:', win.get_wm_class(), `ws=${ws.index()} mon=${mon}`,
            `left=${layout.left?.get_wm_class() ?? '-'} right=${layout.right?.get_wm_class() ?? '-'}`,
            `existing=${hasExistingOther} slots=${slotsUsed} blocking=${winIsBlocking}`);

        if (winIsBlocking && (hasExistingOther || slotsUsed >= 1) && this._isPrimary(mon)) {
            if (!win._bwmOrigin) win._bwmOrigin = { ws };
            this._moveToNewWorkspace(win);
            return;
        }

        this._restoreInitialState(win);
    }

    /** Returns true if there are any other tracked windows on ws:monitor (excluding excludeWin). */
    _hasOtherWindows(ws, mon, excludeWin) {
        for (const w of ws.list_windows()) {
            if (w === excludeWin) continue;
            if (!isTracked(w)) continue;
            if (w.get_monitor() !== mon) continue;
            return true;
        }
        return false;
    }

    _tileKeyboard(side) {
        const win = global.display.get_focus_window();
        if (!win || !isTracked(win)) return;
        if (win._bwmState === `tiled-${side}`) {
            const ws  = win.get_workspace();
            const mon = win.get_monitor();
            LOG('untile:', win.get_wm_class(), 'originWs=', win._bwmOrigin?.ws?.index() ?? 'none',
                'alone=', !this._hasOtherWindows(ws, mon, win));
            win._bwmState = 'floating';
            this._doFloat(win);
            if (ws && mon >= 0)
                this._defer(() => this._tryReturnOrigin(ws, side, mon));
            this._floatReturnToOrigin(win, ws, mon);
        } else {
            this._captureAndSaveFloatGeom(win);
            this._tileWindow(win, side);
        }
    }

    _restoreInitialState(win) {
        win._bwmHandled = true;

        const wa   = win.get_work_area_current_monitor();
        const rect = win.get_frame_rect();
        const wr   = rect.width  / wa.width;
        const hr   = rect.height / wa.height;
        LOG('restoreInitialState:', win.get_wm_class(), `wr=${wr.toFixed(2)} hr=${hr.toFixed(2)}`);

        if (wr > 0.9 && hr > 0.9) {
            win._bwmOrigin = { ws: win.get_workspace() };
            win._bwmPreMax = win._bwmState;
            win._bwmState  = 'maximized'; // pre-set so _doMaximize guard fires and _bwmFloatRect is preserved
            this._doMaximize(win);
        } else if (hr > 0.9 && wr >= 0.2 && wr <= 0.8) {
            const customW   = Math.min(rect.width, Math.floor(wa.width * 0.8));
            const preferred = (rect.x + rect.width / 2) > (wa.x + wa.width / 2) ? 'right' : 'left';
            const ws        = win.get_workspace();
            const mon       = win.get_monitor();
            const layout    = ws ? this._getLayout(ws, mon) : { left: null, right: null };
            const other     = preferred === 'left' ? 'right' : 'left';
            const side      = !layout[preferred] ? preferred : !layout[other] ? other : null;
            if (side) {
                const otherSide = side === 'left' ? 'right' : 'left';
                this._tileWindow(win, side, layout[otherSide] ? null : customW);
            } else {
                win._bwmOrigin = { ws };
                // Pass preferred side so the move logic can reuse an existing workspace
                // that already has a free slot (e.g. a sibling window that just moved there).
                this._moveToNewWorkspace(win, preferred);
            }
        }
        // otherwise leave floating
    }

    // ── Covered-floater relocation ───────────────────────────────────────────

    _onRestacked() {
        if (this._restackedTimer) return;
        this._restackedTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._restackedTimer = null;
            const checked = new Set();
            const manager = global.workspace_manager;
            for (let i = 0; i < manager.get_n_workspaces(); i++) {
                const ws = manager.get_workspace_by_index(i);
                const wins = ws.list_windows();
                // Build per-monitor sets for this workspace in one pass:
                // covering windows (tiled/maximized/fullscreen) and floating windows.
                const coveringByMon = new Map();
                const floatingByMon = new Map();
                for (const w of wins) {
                    if (!isTracked(w)) continue;
                    const mon = w.get_monitor();
                    if (w.fullscreen || w._bwmState === 'maximized' || w._bwmState?.startsWith('tiled')) {
                        if (!coveringByMon.has(mon)) coveringByMon.set(mon, true);
                    } else if (w._bwmState === 'floating') {
                        if (!floatingByMon.has(mon)) floatingByMon.set(mon, true);
                    }
                }
                // Only check ws:mon pairs that have BOTH covering and floating windows.
                for (const mon of coveringByMon.keys()) {
                    if (!floatingByMon.has(mon)) continue;
                    const key = `${i}:${mon}`;
                    if (checked.has(key)) continue;
                    checked.add(key);
                    this._checkCoveredFloaters(ws, mon);
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _checkCoveredFloaters(ws, mon) {

        const coveringWins = ws.list_windows().filter(w =>
            isTracked(w) && w.get_monitor() === mon &&
            (w.fullscreen || w._bwmState === 'maximized' || w._bwmState?.startsWith('tiled'))
        );
        LOG('checkCoveredFloaters ws=', ws.index(), 'mon=', mon,
            'covering=', coveringWins.map(w => w.get_wm_class()));
        if (coveringWins.length === 0) return;

        // Get work area from first covering window
        const wa = coveringWins[0].get_work_area_for_monitor(mon);

        const allWins = ws.list_windows().filter(w =>
            w.get_monitor() === mon && !w.is_on_all_workspaces()
        );
        const sorted   = global.display.sort_windows_by_stacking(allWins);
        const freeArea = this._getFreeArea(ws, mon, wa);

        const coveredFloaters = [];
        for (const floatWin of ws.list_windows()) {
            if (!isTracked(floatWin)) continue;
            if (floatWin.get_monitor() !== mon) continue;
            if (floatWin._bwmState !== 'floating') continue;
            if (floatWin.above) continue;
            if (floatWin.is_on_all_workspaces()) continue;
            if (floatWin._bwmJustMoved) { floatWin._bwmJustMoved = false; continue; }
            if (floatWin._bwmMoving) continue;
            const parent = floatWin.get_transient_for();
            if (parent && isTracked(parent) && parent.get_workspace() === ws) continue;

            const floatIdx = sorted.indexOf(floatWin);
            if (floatIdx === -1) continue;

            const floatRect = floatWin.get_frame_rect();
            const covered   = this._isFullyCovered(floatRect, coveringWins, floatIdx, sorted, wa);
            LOG('  floater:', floatWin.get_wm_class(), `z=${floatIdx} covered=${covered}`);
            if (covered) coveredFloaters.push(floatWin);
        }

        if (coveredFloaters.length === 0) return;
        LOG('covered floaters:', coveredFloaters.map(w => w.get_wm_class()));

        const needNewWs = [];
        for (const floatWin of coveredFloaters) {
            const relocated = this._tryRelocateOnSameWs(floatWin, freeArea) ||
                              this._tryRelocateOnPrevWs(floatWin, ws, mon);
            if (!relocated) needNewWs.push(floatWin);
        }

        if (needNewWs.length > 0)
            this._moveBatchToNewWorkspace(needNewWs);
    }

    _isFullyCovered(floatRect, coveringWins, floatZ, sorted, wa) {
        // Clip to visible (on-screen) area — off-screen portions are not visible
        const floatL = Math.max(floatRect.x, wa.x);
        const floatR = Math.min(floatRect.x + floatRect.width,  wa.x + wa.width);
        const floatT = Math.max(floatRect.y, wa.y);
        const floatB = Math.min(floatRect.y + floatRect.height, wa.y + wa.height);
        if (floatL >= floatR || floatT >= floatB) return true; // entirely off-screen

        const intervals = [];
        for (const cw of coveringWins) {
            const cwIdx = sorted.indexOf(cw);
            if (cwIdx <= floatZ) continue;
            const cr = cw.get_frame_rect();
            if (cr.y + cr.height <= floatRect.y || cr.y >= floatRect.y + floatRect.height) continue;
            intervals.push([cr.x, cr.x + cr.width]);
        }
        if (intervals.length === 0) return false;
        intervals.sort((a, b) => a[0] - b[0]);
        let covered = floatL;
        for (const [s, e] of intervals) {
            if (s > covered) return false;
            covered = Math.max(covered, e);
            if (covered >= floatR) return true;
        }
        return false;
    }

    _getFreeArea(ws, mon, wa) {
        for (const w of ws.list_windows()) {
            if (!isTracked(w)) continue;
            if (w.get_monitor() !== mon) continue;
            if (w.fullscreen || w._bwmState === 'maximized') return null;
        }

        const layout = this._getLayout(ws, mon);
        if (layout.left && layout.right) return null;

        if (layout.left) {
            const r = layout.left.get_frame_rect();
            return { x: r.x + r.width, y: wa.y, width: (wa.x + wa.width) - (r.x + r.width), height: wa.height };
        }
        if (layout.right) {
            const r = layout.right.get_frame_rect();
            return { x: wa.x, y: wa.y, width: r.x - wa.x, height: wa.height };
        }
        return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
    }

    _tryRelocateOnSameWs(floatWin, freeArea) {
        if (!freeArea || freeArea.width < 50) return false;
        const rect = floatWin.get_frame_rect();
        if (rect.width > freeArea.width) return false;
        const newX  = freeArea.x + Math.floor((freeArea.width - rect.width) / 2);
        const clamp = Math.max(freeArea.x, Math.min(newX, freeArea.x + freeArea.width - rect.width));
        LOG('relocate same ws:', floatWin.get_wm_class(), `x: ${rect.x} → ${clamp}`);
        floatWin.move_frame(true, clamp, rect.y);
        return true;
    }

    _tryRelocateOnPrevWs(floatWin, ws, mon) {
        const wsIdx = ws.index();
        if (wsIdx <= 0) return false;
        const prevWs = global.workspace_manager.get_workspace_by_index(wsIdx - 1);
        if (!prevWs) return false;

        const prevWins = prevWs.list_windows().filter(w => w.get_monitor() === mon);
        if (prevWins.length === 0) return false;
        const wa = prevWins[0].get_work_area_for_monitor(mon);

        const prevFree = this._getFreeArea(prevWs, mon, wa);
        LOG('tryRelocatePrevWs:', floatWin.get_wm_class(),
            `prevWs=${wsIdx - 1} prevFree=${JSON.stringify(prevFree)}`);
        if (!prevFree || prevFree.width < 50) return false;

        const rect = floatWin.get_frame_rect();
        if (rect.width > prevFree.width) return false;

        const newX  = prevFree.x + Math.floor((prevFree.width - rect.width) / 2);
        const clamp = Math.max(prevFree.x, Math.min(newX, prevFree.x + prevFree.width - rect.width));
        LOG('relocate prev ws:', floatWin.get_wm_class(), `ws${wsIdx}→ws${wsIdx - 1} x=${clamp}`);

        floatWin._bwmMoving = true;
        floatWin.change_workspace_by_index(wsIdx - 1, false);
        this._defer(() => {
            delete floatWin._bwmMoving;
            if (!isTracked(floatWin)) return;
            floatWin.move_frame(true, clamp, rect.y);
        });
        return true;
    }

    // ── Tile displacement & return ───────────────────────────────────────────

    // If win has a _bwmOrigin ws, is alone on (ws, mon), and origin has no fullscreen —
    // move win back to its origin workspace. Consumes _bwmOrigin.
    _floatReturnToOrigin(win, ws, mon) {
        const originWs = win._bwmOrigin?.ws ?? null;
        delete win._bwmOrigin;
        if (!originWs || originWs === ws) return;
        if (this._hasOtherWindows(ws, mon, win)) return;
        const hasFullscreen = originWs.list_windows().some(w =>
            w.get_monitor() === mon && w.fullscreen);
        if (hasFullscreen) return;
        LOG('floatReturnToOrigin:', win.get_wm_class(), '→ ws', originWs.index());
        win._bwmMoving = true;
        win.change_workspace(originWs);
        originWs.activate(global.get_current_time());
        this._defer(() => { delete win._bwmMoving; });
    }

    // When a tile slot (ws, side, mon) is freed, check if any displaced window wants to return.
    _tryReturnOrigin(ws, side, mon) { try {
        LOG('tryReturnOrigin: called ws=', ws?.index(), 'side=', side);
        if (!ws || ws.index() < 0) { LOG('tryReturnOrigin: ws invalid'); return; }
        const layout = this._getLayout(ws, mon);
        if (layout[side]) { LOG('tryReturnOrigin: slot taken by', layout[side].get_wm_class()); return; }

        // Find a window displaced from this exact slot
        const candidate = global.get_window_actors()
            .map(a => a.meta_window)
            .find(w => w && isTracked(w) &&
                w._bwmOrigin?.ws === ws &&
                w._bwmOrigin?.side === side &&
                w.get_monitor() === mon);
        if (!candidate) { LOG('tryReturnOrigin: no candidate for ws=', ws.index(), 'side=', side); return; }

        // Only return if the candidate is alone on its side (no non-displaced companion)
        const candWs     = candidate.get_workspace();
        const candLayout = candWs ? this._getLayout(candWs, mon) : { left: null, right: null };
        const other      = side === 'left' ? 'right' : 'left';
        const companion  = candLayout[other];
        if (companion && !companion._bwmOrigin) { LOG('tryReturnOrigin: blocked by companion', companion.get_wm_class()); return; }

        LOG('tryReturnOrigin: returning', candidate.get_wm_class(), `to ws${ws.index()} side=${side}`);
        const origin = candidate._bwmOrigin;
        delete candidate._bwmOrigin;
        candidate._bwmMoving = true;
        candidate._bwmState  = `tiled-${side}`;
        candidate.change_workspace(ws);
        ws.activate(global.get_current_time());
        this._defer(() => {
            delete candidate._bwmMoving;
            if (!isTracked(candidate)) return;
            const wa = candidate.get_work_area_for_monitor(mon);
            this._doTile(candidate, side, wa, null);
            // Recursively try to return other displaced windows that were with this one
            this._tryReturnOrigin(origin.ws, other, mon);
        });
    } catch (e) { LOG('tryReturnOrigin: EXCEPTION', e.message, e.stack); } }

    _displaceTile(occupant, side) {
        if (!isTracked(occupant)) return;
        const srcWs  = occupant.get_workspace();
        const mon    = occupant.get_monitor();
        const origin = { ws: srcWs, side };

        // Look for an existing workspace to the left that can absorb the displaced tile.
        // Eligible: the target slot is free, and every tile there was also displaced from srcWs.
        const manager = global.workspace_manager;
        const srcIdx  = srcWs?.index() ?? -1;
        let targetWs  = null;
        for (let i = srcIdx - 1; i >= 0; i--) {
            const ws     = manager.get_workspace_by_index(i);
            const layout = this._getLayout(ws, mon);
            // Prefer same side, accept opposite if same is taken
            const preferredFree = !layout[side];
            const otherFree     = !layout[side === 'left' ? 'right' : 'left'];
            const slotFree      = preferredFree || otherFree;
            if (!slotFree) continue;
            // All tiles on this ws must be displaced from srcWs (no user-placed tiles)
            const wins = ws.list_windows().filter(w =>
                w.get_monitor() === mon && isTracked(w) &&
                (w._bwmState === 'tiled-left' || w._bwmState === 'tiled-right'));
            const allDisplaced = wins.length > 0 && wins.every(w => w._bwmOrigin?.ws === srcWs);
            if (!allDisplaced) continue;
            targetWs = ws;
            break;
        }

        if (targetWs) {
            const layout    = this._getLayout(targetWs, mon);
            const landSide  = !layout[side] ? side : (side === 'left' ? 'right' : 'left');
            LOG('displaceTile: merging', occupant.get_wm_class(), `into existing ws side=${landSide}`);
            occupant._bwmOrigin  = origin;
            occupant._bwmMoving  = true;
            occupant._bwmState   = `tiled-${landSide}`;
            occupant.change_workspace(targetWs);
            this._defer(() => {
                delete occupant._bwmMoving;
                if (!isTracked(occupant)) return;
                const wa = occupant.get_work_area_for_monitor(mon);
                this._doTile(occupant, landSide, wa, null);
            });
        } else {
            LOG('displaceTile: new ws for', occupant.get_wm_class(), `side=${side}`);
            occupant._bwmOrigin = origin;
            this._moveToNewWorkspace(occupant, side, 'left');
        }
    }

    // ── Workspace management ─────────────────────────────────────────────────

    _moveBatchToNewWorkspace(wins) {
        if (wins.length === 0) return;

        const manager    = global.workspace_manager;
        const currentIdx = manager.get_active_workspace_index();
        const newIdx     = currentIdx; // insert LEFT of current workspace

        manager.append_new_workspace(false, global.get_current_time());
        manager.reorder_workspace(
            manager.get_workspace_by_index(manager.get_n_workspaces() - 1),
            newIdx
        );
        const newWs = manager.get_workspace_by_index(newIdx);
        this._ourWorkspaces.add(newWs);
        newWs.connect('window-removed', (_ws, win) => {
            if (win._bwmMoving) return;
            this._defer(() => this._leaveIfEmpty(newWs));
        });

        for (const win of wins) {
            if (!isTracked(win)) continue;
            win._bwmMoving = true;
            win.change_workspace_by_index(newIdx, false);
        }

        // Don't activate — covered floaters fly away silently
        this._defer(() => {
            for (const win of wins) delete win._bwmMoving;
        });
    }

    _moveToRuleWorkspace(win, ruleId) {
        const manager = global.workspace_manager;
        const currentWs = win.get_workspace();

        // 1. Find a workspace that already has a window from the same rule
        for (let i = 0; i < manager.get_n_workspaces(); i++) {
            const ws = manager.get_workspace_by_index(i);
            for (const w of ws.list_windows()) {
                if (w !== win && w._bwmAppliedRules?.has(ruleId)) {
                    LOG('moveToRuleWorkspace:', win.get_wm_class(), '→ existing rule ws', i);
                    win._bwmMoving = true;
                    win.change_workspace(ws);
                    if (manager.get_active_workspace() !== ws)
                        ws.activate(global.get_current_time());
                    this._defer(() => { delete win._bwmMoving; });
                    return;
                }
            }
        }

        // 2. Current workspace has no other tracked windows — stay here
        if (currentWs) {
            const hasOther = currentWs.list_windows().some(
                w => w !== win && isTracked(w) && !w.is_on_all_workspaces()
            );
            if (!hasOther) {
                LOG('moveToRuleWorkspace:', win.get_wm_class(), '— current ws is empty, staying');
                return;
            }
        }

        // 3. Need a fresh workspace
        LOG('moveToRuleWorkspace:', win.get_wm_class(), '— creating new ws');
        this._moveToNewWorkspace(win);
    }

    _moveToNewWorkspace(win, tileOnArrive = null, direction = 'right') {
        if (this._moveInFlight) {
            LOG('moveToNewWorkspace: queued', win.get_wm_class());
            this._moveQueue.push({ win, tileOnArrive, direction });
            return;
        }
        this._moveInFlight = true;
        this._doMoveToNewWorkspace(win, tileOnArrive, direction);
    }

    _doMoveToNewWorkspace(win, tileOnArrive = null, direction = 'right') {
        LOG('moveToNewWorkspace:', win.get_wm_class(),
            tileOnArrive ? `tileOnArrive=${tileOnArrive}` : '', `dir=${direction}`);

        if (win.is_on_all_workspaces()) {
            LOG('moveToNewWorkspace: skipping sticky window', win.get_wm_class());
            this._finishMove(win);
            return;
        }

        const manager    = global.workspace_manager;
        const currentIdx = manager.get_active_workspace_index();
        const oldWs      = win.get_workspace();
        const monitor    = win.get_monitor();

        // If we need to tile on arrival, try existing workspaces first (current, then next).
        if (tileOnArrive && direction === 'right') {
            for (const idx of [currentIdx, currentIdx + 1]) {
                if (idx >= manager.get_n_workspaces()) break;
                const ws     = manager.get_workspace_by_index(idx);
                const layout = this._getLayout(ws, monitor);
                const freeSide = !layout[tileOnArrive] ? tileOnArrive
                               : !layout[tileOnArrive === 'left' ? 'right' : 'left'] ? (tileOnArrive === 'left' ? 'right' : 'left')
                               : null;
                if (freeSide === null) continue;
                LOG('moveToNewWorkspace: reusing ws', idx, 'side=', freeSide, 'for', win.get_wm_class());
                win._bwmMoving = true;
                win.change_workspace(ws);
                ws.activate(global.get_current_time());
                this._defer(() => {
                    delete win._bwmMoving;
                    if (isTracked(win)) this._tileWindow(win, freeSide);
                    this._finishMove(win);
                });
                return;
            }
        }

        manager.append_new_workspace(false, global.get_current_time());
        const newIdx = direction === 'left' ? currentIdx : currentIdx + 1;
        manager.reorder_workspace(
            manager.get_workspace_by_index(manager.get_n_workspaces() - 1),
            newIdx
        );
        const newWs = manager.get_workspace_by_index(newIdx);
        this._ourWorkspaces.add(newWs);
        newWs.connect('window-removed', (_ws, win) => {
            if (win._bwmMoving) return;
            this._defer(() => this._leaveIfEmpty(newWs));
        });

        win._bwmMoving = true;
        win.change_workspace_by_index(newIdx, false);

        if (direction !== 'left') {
            const fullscreen = oldWs?.list_windows()
                .some(w => w.fullscreen && w.get_monitor() === monitor && w !== win);
            if (!fullscreen)
                newWs.activate(global.get_current_time());
        }

        this._defer(() => {
            delete win._bwmMoving;
            if (isTracked(win)) {
                if (tileOnArrive) {
                    this._tileWindow(win, tileOnArrive);
                } else if (win.fullscreen || (win.maximized_horizontally && win.maximized_vertically)) {
                    // Window arrived already maximized — just confirm state, don't call _doMaximize
                    // which would clobber the saved preMaxState.
                    if (win._bwmState !== 'maximized') win._bwmState = 'maximized';
                } else {
                    this._restoreInitialState(win);
                }
            }
            this._finishMove(win);
        });
    }

    _finishMove(_win) {
        this._moveInFlight = false;
        if (this._moveQueue.length > 0) {
            const { win: next, tileOnArrive, direction } = this._moveQueue.shift();
            if (isTracked(next)) {
                this._moveInFlight = true;
                this._doMoveToNewWorkspace(next, tileOnArrive, direction);
            } else {
                this._finishMove(null);
            }
        }
    }
}
