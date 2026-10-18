/* drag.js — dragging by the title bar, resizing a tile by hand, and Super+Left/Right.
 *
 * Follows the grab, shows the snap preview and dispatches what the user did. On a secondary
 * monitor it stands in for GNOME's own tiling instead, by itself: nothing there is arranged.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { LOG, name } from './log.js';

export const SNAP_PX = 32;
export const DRAG_THRESHOLD = 20;
const POLL_MS = 33;

export class DragController {
    constructor({ registry, windows, rules, dispatch }) {
        this._registry = registry;
        this._windows = windows;
        this._rules = rules;
        this._dispatch = dispatch;
        this.android = null;
        this._drag = null;
        this._zone = null;
        this._resize = null;
        this._pollId = null;
        this._plainTiles = new Map();
        this._handles = [];
    }

    enable() {
        // GNOME's own tile-preview style, so the preview follows the accent colour
        this._preview = new St.Widget({ style_class: 'tile-preview', visible: false });
        Main.layoutManager.uiGroup.add_child(this._preview);
        const d = global.display;
        this._handles = [
            [d, d.connect('grab-op-begin', (_d, win, op) => this._onGrabBegin(win, op))],
            [d, d.connect('grab-op-end', (_d, win, op) => this._onGrabEnd(win, op))],
        ];
    }

    disable() {
        for (const [obj, id] of this._handles) obj.disconnect(id);
        this._handles = [];
        if (this._pollId) GLib.source_remove(this._pollId);
        this._pollId = null;
        this._drag = this._resize = null;
        this._plainTiles.clear();
        this._preview?.destroy();
        this._preview = null;
    }

    isDragging(win) {
        return this._drag?.win === win;
    }

    _primary(win) {
        return win.get_monitor() === global.display.get_primary_monitor();
    }

    _onGrabBegin(win, op) {
        if (!win) return;
        LOG('drag: grab begins', name(win), `op=${op}`);
        // Chrome's detached tab windows on Wayland never send window-created
        if (!this._registry.get(win) && !this._registry.isIgnored(win) && this._windows.isRelevant(win)
            && !this._rules.isIgnored(win) && !this.android?.isAndroid(win)) {
            LOG('drag: registering late', name(win));
            this._windows.register(win, { batch: false });
        }
        // resizing any Waydroid window resizes Android's whole display: never snapped
        if (this.android?.isFullScreen(win)) return;
        const rec = this._registry.get(win);
        const plain = !rec && win.window_type === Meta.WindowType.NORMAL && !this._primary(win);
        if (!rec && !plain) return;

        // a grab may carry flags: Chrome's tab dragged out of its window moves UNCONSTRAINED, and
        // compared whole that grab was never taken for a move, so a tab was never snapped
        const kind = op & ~(Meta.GrabOp.WINDOW_FLAG_UNCONSTRAINED ?? 1024);
        if (kind === Meta.GrabOp.MOVING || kind === Meta.GrabOp.KEYBOARD_MOVING) {
            // set first: Mutter unmaximizes a dragged window at once, and that must already be known
            const [x, y] = global.get_pointer();
            this._drag = {
                win, startX: x, startY: y, detached: false, plain,
                blocking: !!rec && rec.role !== 'floating',
            };
            this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
                if (!this._drag) {
                    this._pollId = null;
                    return GLib.SOURCE_REMOVE;
                }
                try { this._poll(); } catch (e) { LOG('drag: poll failed', e.message); }
                return GLib.SOURCE_CONTINUE;
            });
            return;
        }
        if (rec && (rec.role === 'tiled-left' || rec.role === 'tiled-right')) this._resize = win;
    }

    _monitorAt(x, y) {
        const monitors = Main.layoutManager.monitors;
        const i = monitors.findIndex(m => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        return i < 0 ? 0 : i;
    }

    _poll() {
        const d = this._drag;
        const [x, y] = global.get_pointer();
        const monitor = this._monitorAt(x, y);
        const wa = d.win.get_work_area_for_monitor(monitor);
        let zone = null;
        if (Math.hypot(x - d.startX, y - d.startY) >= DRAG_THRESHOLD) {
            if (!d.detached) {
                d.detached = true;
                if (d.plain) this._plainRestore(d.win, true);
                else if (d.blocking) this._dispatch({ type: 'detached', win: d.win });
            }
            if (x <= wa.x + SNAP_PX) zone = 'left';
            else if (x >= wa.x + wa.width - SNAP_PX) zone = 'right';
            else if (y <= wa.y + SNAP_PX) zone = 'maximize';
        }
        d.monitor = monitor;
        if (zone !== this._zone) {
            this._zone = zone;
            LOG('drag: zone', zone ?? 'none');
            if (zone) this._showPreview(zone, wa);
            else this._preview.hide();
        }
    }

    _showPreview(zone, wa) {
        const half = Math.floor(wa.width / 2);
        const [x, y, w, h] = {
            left: [wa.x, wa.y, half, wa.height],
            right: [wa.x + half, wa.y, wa.width - half, wa.height],
            maximize: [wa.x, wa.y, wa.width, wa.height],
        }[zone];
        this._preview.set_position(x, y);
        this._preview.set_size(w, h);
        this._preview.show();
    }

    _onGrabEnd(win, _op) {
        if (this._drag?.win === win) {
            const { plain, monitor } = this._drag;
            const zone = this._zone;
            this._drag = null;
            this._zone = null;
            this._preview.hide();
            if (zone) {
                LOG('drag: dropped', name(win), 'at', zone);
                const onPrimary = (monitor ?? win.get_monitor()) === global.display.get_primary_monitor();
                if (plain || !onPrimary) this._plainTile(win, zone);
                else if (this._registry.get(win)) this._dispatch({ type: 'dropped', win, zone });
            }
        }
        if (this._resize === win) {
            this._resize = null;
            this._dispatch({ type: 'resized', win, width: win.get_frame_rect().width });
        }
    }

    tileKeyboard(side) {
        const win = global.display.get_focus_window();
        if (!win || this.android?.isFullScreen(win)) return;
        const rec = this._registry.get(win);
        if (rec && this._primary(win)) {
            LOG('drag: Super+', side, name(win), rec.role);
            if (rec.role === `tiled-${side}`) this._dispatch({ type: 'untile', win });
            else this._dispatch({ type: 'tile', win, side, explicit: true });
        } else if (win.window_type === Meta.WindowType.NORMAL) {
            this._plainTile(win, side);
        }
    }

    // GNOME's tiling, for a secondary monitor: the chosen half or the whole work area, the
    // window's geometry remembered first and given back on the second press or a drag away.
    _plainTile(win, zone) {
        const held = this._plainTiles.get(win);
        if (held?.zone === zone) {
            this._plainRestore(win, false);
            return;
        }
        if (!held) {
            const r = win.get_frame_rect();
            this._plainTiles.set(win, { zone, rect: { x: r.x, y: r.y, width: r.width, height: r.height } });
        } else {
            held.zone = zone;
        }
        if (zone === 'maximize') {
            win.maximize();
            return;
        }
        if (win.maximized_horizontally || win.maximized_vertically) win.unmaximize();
        const wa = win.get_work_area_current_monitor();
        const half = Math.floor(wa.width / 2);
        const x = zone === 'left' ? wa.x : wa.x + half;
        win.move_frame(true, x, wa.y);
        win.move_resize_frame(true, x, wa.y, zone === 'left' ? half : wa.width - half, wa.height);
    }

    _plainRestore(win, sizeOnly) {
        const held = this._plainTiles.get(win);
        if (!held) return;
        this._plainTiles.delete(win);
        if (win.maximized_horizontally || win.maximized_vertically) win.unmaximize();
        const r = win.get_frame_rect();
        const { x, y, width, height } = held.rect;
        if (sizeOnly) win.move_resize_frame(true, r.x, r.y, width, height);
        else win.move_resize_frame(true, x, y, width, height);
    }
}
