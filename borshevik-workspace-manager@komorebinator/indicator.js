/* indicator.js — the panel indicator that replaces the Activities button.
 *
 * The wall at a glance: one button per workspace with its windows' icons. It shows and switches;
 * it places nothing. What it shows is read into a model (indicator-model.js), and only what
 * changed from the model shown is applied to the buttons (indicator-view.js), which stay from one
 * change to the next. Reordering by dragging a button is workspace-drag.js's.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WorkspaceDrag } from './workspace-drag.js';
import { IndicatorView } from './indicator-view.js';
import { diff, readWall } from './indicator-model.js';
import { handler, measure } from './perf.js';
import { dropRemovedWorkspaces } from './workspaces.js';

export class Indicator {
    constructor({ registry, isRelevant, path }) {
        this._registry = registry;
        this._isRelevant = isRelevant;
        this._path = path;
        this._timer = null;
        this._handles = [];
        this._wsHandles = [];
        this._model = [];
        this._view = null;
        this._drag = null;
        this._stale = false;
    }

    enable() {
        Main.panel.statusArea['activities']?.hide();
        this._box = new St.BoxLayout({ style_class: 'bwm-indicator' });
        Main.panel._leftBox.insert_child_at_index(this._box, 0);
        // the panel goes before the extension is disabled when the session ends: nothing may be
        // built into it after
        this._box.connect('destroy', () => {
            this._box = null;
            this._view = null;
            if (this._timer) GLib.source_remove(this._timer);
            this._timer = null;
        });
        this._view = new IndicatorView({
            box: this._box, path: this._path,
            onLogo: () => Main.overview.toggle(),
            onClick: b => b.ws.activate(global.get_current_time()),
            onPress: (b, event) => this._onPress(b, event),
        });
        this._view.setOverview(Main.overview.visible);
        const wm = global.workspace_manager, tracker = Shell.WindowTracker.get_default();
        const update = what => handler(`indicator: ${what}`, () => this._schedule());
        const overview = shown => handler(`indicator: overview ${shown ? 'showing' : 'hiding'}`,
            () => this._view?.setOverview(shown));
        this._handles = [
            [wm, wm.connect('active-workspace-changed', update('active-workspace-changed'))],
            [wm, wm.connect('workspace-added', handler('indicator: workspace-added', (_m, i) => {
                this._watchWorkspace(wm.get_workspace_by_index(i));
                this._schedule();
            }))],
            [wm, wm.connect('workspace-removed', handler('indicator: workspace-removed', () => {
                this._wsHandles = dropRemovedWorkspaces(this._wsHandles);
                this._schedule();
            }))],
            [wm, wm.connect('workspaces-reordered', update('workspaces-reordered'))],
            [tracker, tracker.connect('tracked-windows-changed', update('tracked-windows-changed'))],
            [Main.overview, Main.overview.connect('showing', overview(true))],
            [Main.overview, Main.overview.connect('hiding', overview(false))],
            [Main.sessionMode, Main.sessionMode.connect('updated',
                handler('indicator: session mode updated', () => this._onSessionModeUpdated()))],
        ];
        // a window moving between workspaces changes nothing else the indicator follows
        for (let i = 0; i < wm.get_n_workspaces(); i++) this._watchWorkspace(wm.get_workspace_by_index(i));
        this._onSessionModeUpdated();
        this._schedule();
    }

    _watchWorkspace(ws) {
        const update = what => handler(`indicator: ${what}`, () => this._schedule());
        this._wsHandles.push([ws, ws.connect('window-added', update('window-added'))],
            [ws, ws.connect('window-removed', update('window-removed'))]);
    }

    // After a plan has run: a window changing role reorders its workspace's icons, and Mutter
    // sends nothing the indicator follows for it.
    refresh() {
        this._schedule();
    }

    // the buttons shown, for the performance report
    get size() {
        return this._view?.size ?? 0;
    }

    disable() {
        this._drag?.cancel();
        for (const [obj, id] of this._handles) obj.disconnect(id);
        this._handles = [];
        for (const [ws, id] of this._wsHandles) {
            try { ws.disconnect(id); } catch {}   // a workspace GNOME has removed
        }
        this._wsHandles = [];
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = null;
        this._box?.destroy();
        this._box = null;
        this._view = null;
        this._model = [];
        Main.panel.statusArea['activities']?.show();
    }

    // The extension stays enabled on the lock screen, where the panel is still shown: the icons of
    // every open app must not be on show to whoever is at the locked machine.
    _onSessionModeUpdated() {
        if (Main.sessionMode.isLocked) this._drag?.cancel();
        if (this._box) this._box.visible = !Main.sessionMode.isLocked;
    }

    // Once per burst of signals, at idle. During a drag nothing changes: the drag has measured the
    // buttons where they stood.
    _schedule() {
        if (!this._box) return;
        if (this._drag) {
            this._stale = true;
            return;
        }
        if (this._timer) return;
        this._timer = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._timer = null;
            measure('later', 'indicator: update', () => this._update());
            return GLib.SOURCE_REMOVE;
        });
    }

    _update() {
        const next = readWall({
            registry: this._registry, isRelevant: this._isRelevant, tracker: Shell.WindowTracker.get_default(),
        });
        const changes = diff(this._model, next);
        this._model = next;
        if (changes.length) this._view.apply(changes, next);
    }

    // a press may become a drag; until it does, the click is the button's
    _onPress(b, event) {
        if (event.get_button() !== 1 || this._drag) return Clutter.EVENT_PROPAGATE;
        this._drag = new WorkspaceDrag({
            buttons: this._view.buttons(), source: b, box: this._box, start: event.get_coords(),
            onEnd: dragged => this._dragEnded(dragged),
        });
        return Clutter.EVENT_PROPAGATE;
    }

    // What a real drag moved goes back with the buttons, and a reorder it made comes as a signal:
    // the model is read again either way.
    _dragEnded(dragged) {
        this._drag = null;
        if (this._stale || dragged) {
            this._stale = false;
            this._schedule();
        }
    }
}
