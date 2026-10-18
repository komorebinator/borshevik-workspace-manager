/* indicator.js — the panel indicator that replaces the Activities button.
 *
 * The wall at a glance: one button per workspace with its windows' icons. It shows and switches;
 * it places nothing.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class Indicator {
    constructor({ registry, isRelevant, path }) {
        this._registry = registry;
        this._isRelevant = isRelevant;
        this._path = path;
        this._timer = null;
        this._handles = [];
    }

    enable() {
        Main.panel.statusArea['activities']?.hide();
        this._box = new St.BoxLayout({ style_class: 'bwm-indicator' });
        Main.panel._leftBox.insert_child_at_index(this._box, 0);
        const wm = global.workspace_manager, tracker = Shell.WindowTracker.get_default();
        const update = () => this._schedule();
        this._handles = [
            [wm, wm.connect('active-workspace-changed', update)],
            [wm, wm.connect('workspace-added', update)],
            [wm, wm.connect('workspace-removed', update)],
            [wm, wm.connect('workspaces-reordered', update)],
            [tracker, tracker.connect('tracked-windows-changed', update)],
            [Main.overview, Main.overview.connect('showing', () => this._logoBg?.add_style_class_name('bwm-logo-active'))],
            [Main.overview, Main.overview.connect('hiding', () => this._logoBg?.remove_style_class_name('bwm-logo-active'))],
            [Main.sessionMode, Main.sessionMode.connect('updated', () => this._onSessionModeUpdated())],
        ];
        this._onSessionModeUpdated();
        this._schedule();
    }

    disable() {
        for (const [obj, id] of this._handles) obj.disconnect(id);
        this._handles = [];
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = null;
        this._box?.destroy();
        this._box = null;
        Main.panel.statusArea['activities']?.show();
    }

    // The extension stays enabled on the lock screen, where the panel is still shown: the icons of
    // every open app must not be on show to whoever is at the locked machine.
    _onSessionModeUpdated() {
        if (this._box) this._box.visible = !Main.sessionMode.isLocked;
    }

    _schedule() {
        if (this._timer) return;
        this._timer = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._timer = null;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _update() {
        this._box.destroy_all_children();
        const wm      = global.workspace_manager;
        const nWs     = wm.get_n_workspaces();
        const activeI = wm.get_active_workspace_index();
        const tracker = Shell.WindowTracker.get_default();
        const ICON    = 22;

        // Logo button
        const logoPath = this._path + '/bwm_icon.svg';
        const logoBtn = new St.Button({
            style_class: 'bwm-logo-btn', reactive: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        logoBtn.set_y_expand(true);
        const logoIcon = new St.Icon({ gicon: Gio.icon_new_for_string(logoPath), icon_size: 22,
            y_align: Clutter.ActorAlign.CENTER });
        logoIcon.opacity = 204; // 80%
        const logoBg = new St.Bin({ style_class: 'bwm-logo-bg', child: logoIcon });
        if (Main.overview.visible) logoBg.add_style_class_name('bwm-logo-active');
        this._logoBg = logoBg;
        logoBtn.set_child(logoBg);
        logoBtn.connect('enter-event', () => { logoIcon.opacity = 255; });
        logoBtn.connect('leave-event', () => { logoIcon.opacity = 204; });
        logoBtn.connect('clicked', () => Main.overview.toggle());
        this._box.add_child(logoBtn);

        for (let i = 0; i < nWs; i++) {
            const ws = wm.get_workspace_by_index(i);
            const roleOf = w => this._registry.get(w)?.role;
            const winOrder = w => w.fullscreen ? 0 : roleOf(w) === 'full' ? 1
                                : roleOf(w) === 'tiled-left' ? 2 : roleOf(w) === 'tiled-right' ? 3 : 4;
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
            if (!isLast) btn._bwmWs = ws;
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
                        this._updateDragTarget(cx, ws);
                        return Clutter.EVENT_PROPAGATE;
                    }

                    if (type === Clutter.EventType.BUTTON_RELEASE) {
                        global.stage.disconnect(captureId);
                        if (!activeDrag) return Clutter.EVENT_PROPAGATE;
                        clone.destroy();
                        bg.opacity = 255;
                        this._commitDrop(ws, isLast);
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

            this._box.add_child(btn);
        }
    }

    _updateDragTarget(cx, srcWs) {
        let found = null;
        for (const child of this._box.get_children()) {
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

    _commitDrop(srcWs, activate = false) {
        const target = this._wsDragTarget;
        this._wsDragTarget?._bwmBg.remove_style_class_name('bwm-ws-drag-over');
        this._wsDragTarget = null;
        if (!target) return;
        global.workspace_manager.reorder_workspace(srcWs, target._bwmWs.index());
        if (activate)
            srcWs.activate(global.get_current_time());
    }
}
