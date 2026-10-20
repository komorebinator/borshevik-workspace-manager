/* indicator-view.js — the panel indicator's actors, kept from one change to the next.
 *
 * One button per workspace, made when its workspace comes into the model and destroyed when it
 * leaves; everything else — its number, whether it is the active one, its icons — is changed on
 * the button that is there. Each kind of change is a method of its own, where an animation of
 * that change belongs. Decides nothing: what to show is indicator-model.js's, what a click or a
 * press does is the indicator's.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import { count } from './perf.js';

const ICON_PX = 22;
const INACTIVE_OPACITY = 204;   // 80%

export class IndicatorView {
    // box: where the buttons go, after the logo; onLogo(), onClick(button), onPress(button, event)
    constructor({ box, path, onLogo, onClick, onPress }) {
        this._box = box;
        this._onClick = onClick;
        this._onPress = onPress;
        this._buttons = new Map();   // workspace → button
        this._order = [];
        this._buildLogo(path, onLogo);
    }

    // in the order shown: { actor, bg, ws, plus } for workspace-drag, and the view's own parts
    buttons() {
        return [...this._order];
    }

    get size() {
        return this._buttons.size;
    }

    setOverview(shown) {
        if (shown) this._logoBg.add_style_class_name('bwm-logo-active');
        else this._logoBg.remove_style_class_name('bwm-logo-active');
    }

    // changes: indicator-model.js#diff's, from the model shown to next
    apply(changes, next) {
        for (const c of changes) {
            const b = this._buttons.get(c.entry.ws);
            switch (c.type) {
            case 'removed': this._remove(b); break;
            case 'added': this._add(c.entry); break;
            // the order is set once every button is there, below
            case 'moved': break;
            case 'num': this._setNum(b, c.entry.num); break;
            case 'active': this._setActive(b, c.entry.active); break;
            case 'icons': this._setIcons(b, c.entry); break;
            }
        }
        this._order = next.map(e => this._buttons.get(e.ws));
        this._order.forEach((b, i) => {
            if (this._box.get_child_at_index(i + 1) !== b.actor) this._box.set_child_at_index(b.actor, i + 1);
        });
    }

    _buildLogo(path, onLogo) {
        const btn = new St.Button({ style_class: 'bwm-logo-btn', reactive: true, y_align: Clutter.ActorAlign.FILL });
        btn.set_y_expand(true);
        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${path}/bwm_icon.svg`), icon_size: ICON_PX,
            y_align: Clutter.ActorAlign.CENTER, opacity: INACTIVE_OPACITY,
        });
        this._logoBg = new St.Bin({ style_class: 'bwm-logo-bg', child: icon });
        btn.set_child(this._logoBg);
        btn.connect('enter-event', () => { icon.opacity = 255; });
        btn.connect('leave-event', () => { icon.opacity = INACTIVE_OPACITY; });
        btn.connect('clicked', () => onLogo());
        this._box.insert_child_at_index(btn, 0);
    }

    _add(entry) {
        count('other', 'indicator: buttons built');
        const actor = new St.Button({ style_class: 'bwm-ws', reactive: true, y_align: Clutter.ActorAlign.FILL });
        actor.set_y_expand(true);
        const num = new St.Label({ text: `${entry.num}`, style_class: 'bwm-ws-num', y_align: Clutter.ActorAlign.CENTER });
        const row = new St.BoxLayout({ style_class: 'bwm-ws-row' });
        row.add_child(num);
        // one for the whole row, switched rather than made anew: each effect draws its actor
        // through a buffer of its own at every paint of the panel
        const grey = new Clutter.DesaturateEffect({ factor: 1.0 });
        row.add_effect(grey);
        const bg = new St.Bin({ style_class: 'bwm-ws-bg', child: row });
        actor.set_child(bg);
        const b = { actor, bg, row, num, grey, ws: entry.ws, plus: false, plusIcon: null, icons: [] };
        actor.connect('clicked', () => this._onClick(b));
        actor.connect('button-press-event', (_a, event) => this._onPress(b, event));
        this._buttons.set(entry.ws, b);
        this._box.add_child(actor);
        this._setActive(b, entry.active);
        this._setIcons(b, entry);
    }

    _remove(b) {
        this._buttons.delete(b.ws);
        b.actor.destroy();
    }

    _setNum(b, num) {
        b.num.text = `${num}`;
    }

    _setActive(b, active) {
        b.actor.opacity = active ? 255 : INACTIVE_OPACITY;
        if (active) b.bg.add_style_class_name('bwm-ws-active');
        else b.bg.remove_style_class_name('bwm-ws-active');
        b.grey.enabled = !active;
    }

    // An app's icon is taken over from the button's own before one is made: a window gone or come
    // makes one icon, not the whole row's.
    _setIcons(b, entry) {
        const spare = new Map();   // app id → its icons not yet taken
        for (const icon of b.icons) {
            b.row.remove_child(icon.actor);
            if (!spare.has(icon.appId)) spare.set(icon.appId, []);
            spare.get(icon.appId).push(icon.actor);
        }
        b.icons = [];
        if (entry.plus && !b.plusIcon) {
            b.plusIcon = new St.Icon({
                icon_name: 'list-add-symbolic', icon_size: 14, style_class: 'bwm-ws-plus',
                y_align: Clutter.ActorAlign.CENTER,
            });
            b.row.add_child(b.plusIcon);
        } else if (!entry.plus && b.plusIcon) {
            b.plusIcon.destroy();
            b.plusIcon = null;
        }
        b.plus = entry.plus;
        for (const { app } of entry.icons) {
            const appId = app.get_id();
            let actor = spare.get(appId)?.pop();
            if (!actor) {
                count('other', 'indicator: icons built');
                actor = app.create_icon_texture(ICON_PX);
                actor.style_class = 'bwm-app-icon';
            }
            b.row.add_child(actor);
            b.icons.push({ appId, actor });
        }
        for (const left of spare.values()) for (const actor of left) actor.destroy();
    }
}
