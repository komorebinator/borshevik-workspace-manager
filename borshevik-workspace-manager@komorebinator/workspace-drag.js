/* workspace-drag.js — dragging a workspace's button in the panel indicator.
 *
 * One drag, from the press to its end. The workspace is inserted between two others, as tabs are
 * reordered: the buttons around the insertion point move apart, so where it will land is seen
 * before it is dropped. Escape, or a release away from the indicator, changes nothing.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { LOG } from './log.js';

const DRAG_THRESHOLD_PX = 6;
const GAP_MS = 150;
const OUTLINE_PX = 2;   // .bwm-ws-dragged's border, around the clone

const alive = ws => {
    const wm = global.workspace_manager;
    for (let i = 0; i < wm.get_n_workspaces(); i++) {
        if (wm.get_workspace_by_index(i) === ws) return true;
    }
    return false;
};

export class WorkspaceDrag {
    // buttons: the indicator's, in the order shown; source: the one pressed; onEnd(dragged): called
    // once, as it ends either way
    constructor({ buttons, source, box, start, onEnd }) {
        this._buttons = buttons;
        this._source = source;
        this._box = box;
        this._start = start;
        this._onEnd = onEnd;
        this._others = buttons.filter(b => b !== source);
        this._from = buttons.indexOf(source);
        this._gap = this._from;
        this._clone = null;
        this._grab = null;
        this._holder = null;
        this._ended = false;
        this._captureId = 0;
        this._listen(global.stage, 'captured-event');
    }

    // Until the drag starts, the stage's captured events, seen before the buttons see them. Then
    // every event, from an actor of its own holding the pointer, as GNOME's own drags do: released
    // over a window, the button would otherwise go to that window's app, and the drag would never
    // see it end; and a grab has no capture phase, so it is the actor's plain events.
    _listen(actor, signal) {
        if (this._captureId) this._listening.disconnect(this._captureId);
        this._listening = actor;
        this._captureId = actor.connect(signal, (_a, ev) => this._onEvent(ev));
    }

    cancel() {
        this._end('cancelled');
    }

    _onEvent(ev) {
        const type = ev.type();
        if (type === Clutter.EventType.MOTION) {
            // a release this never saw: nothing may stay waiting for it
            if (!(ev.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
                this._end('a motion with the button up: its release was missed');
                return Clutter.EVENT_PROPAGATE;
            }
            const [x, y] = ev.get_coords();
            if (!this._clone) {
                if (Math.hypot(x - this._start[0], y - this._start[1]) < DRAG_THRESHOLD_PX)
                    return Clutter.EVENT_PROPAGATE;
                this._begin();
            }
            this._clone.set_x(Math.round(x - this._clone.width / 2));
            this._openGap(this._insertionAt(x));
            return Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE) {
            // a press that never became a drag is a click, the button's own
            if (!this._clone) {
                this._end(null);
                return Clutter.EVENT_PROPAGATE;
            }
            const [x, y] = ev.get_coords();
            const away = !this._over(x, y);
            const gap = this._gap;
            this._end(away ? 'released away, cancelled' : 'released');
            if (!away) this._drop(gap);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.KEY_PRESS && ev.get_key_symbol() === Clutter.KEY_Escape && this._clone) {
            this._end('Escape, cancelled');
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _begin() {
        this._holder = new Clutter.Actor({ width: 0, height: 0, reactive: true });
        Main.layoutManager.uiGroup.add_child(this._holder);
        this._grab = Main.pushModal(this._holder);
        this._listen(this._holder, 'event');
        // where each button stands with nothing moved, and the dragged one taken out
        this._width = this._source.actor.width;
        this._left = this._buttons.map((b, i) => {
            const [x] = b.actor.get_transformed_position();
            return i > this._from ? x - this._width : x;
        });
        const bg = this._source.bg;
        const [bx, by] = bg.get_transformed_position();
        // Only what the button shows is cloned, its number and icons: the background is the
        // frame's own, the same whichever workspace is dragged — the active one's, lighter still
        // under the pointer, swallowed the outline. A clone takes no style, hence the frame.
        this._clone = new St.Bin({
            style_class: 'bwm-ws-dragged', child: new Clutter.Clone({ source: bg.get_child() }),
            x: bx - OUTLINE_PX, y: by - OUTLINE_PX,
        });
        Main.layoutManager.uiGroup.add_child(this._clone);
        // its place stays empty until the gap moves away from it
        bg.opacity = 0;
        LOG('indicator: dragging workspace', this._source.ws.index());
    }

    // The dragged button, centred on the pointer, takes the place of every button whose middle its
    // left edge has passed, measured with it taken out of the row: what the gap moves cannot move
    // the answer.
    _insertionAt(x) {
        const edge = x - this._width / 2;
        let k = 0;
        this._others.forEach(b => {
            const i = this._buttons.indexOf(b);
            if (!b.plus && this._left[i] + b.actor.width / 2 < edge) k++;
        });
        return k;
    }

    _openGap(k) {
        if (k === this._gap) return;
        this._gap = k;
        this._others.forEach((b, v) => {
            const after = this._buttons.indexOf(b) > this._from;
            const shift = (v >= k ? this._width : 0) - (after ? this._width : 0);
            b.actor.ease({ translation_x: shift, duration: GAP_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        });
    }

    _over(x, y) {
        const [bx, by] = this._box.get_transformed_position();
        const [bw, bh] = this._box.get_transformed_size();
        return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
    }

    // By the workspaces themselves: the indicator leaves empty ones out, so its buttons are not
    // numbered like the workspaces.
    _drop(k) {
        if (k === this._from) return;
        const src = this._source.ws;
        const next = this._others[k];
        const prev = this._others[k - 1];
        if (!alive(src) || !alive(next?.ws ?? prev.ws)) {
            LOG('indicator: drop on a workspace that is gone, nothing moved');
            return;
        }
        const from = src.index();
        let to;
        if (next) {
            const i = next.ws.index();
            to = i < from ? i : i - 1;
        } else {
            const i = prev.ws.index();
            to = i < from ? i + 1 : i;
        }
        LOG('indicator: workspace', from, '→', to);
        global.workspace_manager.reorder_workspace(src, to);
        if (this._source.plus) src.activate(global.get_current_time());
    }

    // why: for the log, or null for a press that was only a click
    _end(why) {
        if (this._ended) return;
        this._ended = true;
        if (why) LOG('indicator: drag ended,', why);
        this._listening.disconnect(this._captureId);
        this._captureId = 0;
        if (this._grab) Main.popModal(this._grab);
        this._grab = null;
        this._holder?.destroy();
        this._holder = null;
        const dragged = !!this._clone;
        // the release went to the drag, not the button, which would stay pressed, holding the
        // pointer: let it go without a click
        if (dragged) this._source.actor.fake_release();
        this._clone?.destroy();
        this._clone = null;
        this._source.bg.opacity = 255;
        // back at once: a rebuild follows
        for (const b of this._buttons) {
            b.actor.remove_all_transitions();
            b.actor.translation_x = 0;
        }
        this._onEnd(dragged);
    }
}
