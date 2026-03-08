/* extension.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Meta from "gi://Meta";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

export default class BorshevikWorkspaceManager extends Extension {

    enable() {
        this._settings = this.getSettings();

        this._handles = [
            global.window_manager.connect('map',          (_, act) => this._onMap(act)),
            global.window_manager.connect('size-changed', (_, act) => this._onSizeChanged(act)),
        ];
    }

    disable() {
        this._handles.splice(0).forEach(h => global.window_manager.disconnect(h));
        this._settings = null;
    }

    // --- Signal handlers ---

    _onMap(act) {
        const win = act.meta_window;
        if (!this._isRelevantWindow(win) || !this._settings.get_boolean('move-window-when-maximized'))
            return;
        this._handleNewWindow(win);
    }

    _onSizeChanged(act) {
        const win = act.meta_window;
        if (!this._isRelevantWindow(win))
            return;
        this._handleSwap(win);
    }

    // --- Window predicates ---

    _isRelevantWindow(win) {
        return win.window_type === Meta.WindowType.NORMAL && !win.skip_taskbar;
    }

    _getTileDirection(win) {
        const rect = win.tile_rect;
        if (!rect || rect.width <= 0) return null;
        const workArea = win.get_work_area_current_monitor();
        return rect.x + rect.width / 2 < workArea.x + workArea.width / 2 ? 'left' : 'right';
    }

    _isMaximized(win) {
        return win.maximized_horizontally && win.maximized_vertically;
    }

    // --- Workspace state ---

    _getRelevantWindows(workspace, monitor, excludeWin = null) {
        return workspace.list_windows().filter(w =>
            w !== excludeWin &&
            !w.is_always_on_all_workspaces() &&
            w.get_monitor() === monitor &&
            this._isRelevantWindow(w)
        );
    }

    _getMonitorState(workspace, monitor, excludeWin = null) {
        const windows = this._getRelevantWindows(workspace, monitor, excludeWin);

        if (windows.some(w => w.fullscreen))         return 'fullscreen';
        if (windows.some(w => this._isMaximized(w))) return 'maximized';

        const hasLeft  = windows.some(w => this._getTileDirection(w) === 'left');
        const hasRight = windows.some(w => this._getTileDirection(w) === 'right');

        if (hasLeft && hasRight) return 'tiled-both';
        if (hasLeft)             return 'tiled-left';
        if (hasRight)            return 'tiled-right';
        return 'empty';
    }

    // --- Tiling helpers ---

    _tileWindow(win, direction) {
        const current = this._getTileDirection(win);
        if (current === direction) return;
        if (current === 'left')  win.toggle_tiled_left();
        if (current === 'right') win.toggle_tiled_right();
        if (direction === 'left')  win.toggle_tiled_left();
        if (direction === 'right') win.toggle_tiled_right();
    }

    _applyAutoSizeRules(win) {
        const workArea = win.get_work_area_current_monitor();
        const rect     = win.get_frame_rect();
        const wRatio   = rect.width  / workArea.width;
        const hRatio   = rect.height / workArea.height;

        if (wRatio > 0.9 && hRatio > 0.9)
            win.maximize(Meta.MaximizeFlags.HORIZONTAL | Meta.MaximizeFlags.VERTICAL);
        else if (hRatio > 0.9 && wRatio >= 0.4 && wRatio <= 0.6)
            this._tileWindow(win, 'left');
    }

    _deferCall(fn) {
        global.compositor.get_laters().add(Meta.LaterType.IDLE, () => { fn(); return false; });
    }

    // --- Core logic ---

    _handleNewWindow(win) {
        const monitor   = win.get_monitor();
        const workspace = win.get_workspace();
        const state     = this._getMonitorState(workspace, monitor, win);

        if (state === 'tiled-left') {
            this._deferCall(() => this._tileWindow(win, 'right'));
            return;
        }
        if (state === 'tiled-right') {
            this._deferCall(() => this._tileWindow(win, 'left'));
            return;
        }
        if (state === 'empty') return;

        // 'maximized', 'fullscreen', or 'tiled-both' → move to a new workspace
        const manager    = global.workspace_manager;
        const currentIdx = manager.get_active_workspace_index();

        manager.append_new_workspace(false, global.get_current_time());
        const newIdx = currentIdx + 1;
        manager.reorder_workspace(
            manager.get_workspace_by_index(manager.get_n_workspaces() - 1),
            newIdx
        );

        win.change_workspace_by_index(newIdx, false);

        if (state !== 'fullscreen')
            manager.get_workspace_by_index(newIdx).activate(global.get_current_time());

        this._deferCall(() => this._applyAutoSizeRules(win));
    }

    _handleSwap(win) {
        const direction = this._getTileDirection(win);
        if (!direction) return;

        const conflict = this._getRelevantWindows(win.get_workspace(), win.get_monitor(), win)
            .find(w => this._getTileDirection(w) === direction);
        if (!conflict) return;

        this._tileWindow(conflict, direction === 'left' ? 'right' : 'left');
    }
}
