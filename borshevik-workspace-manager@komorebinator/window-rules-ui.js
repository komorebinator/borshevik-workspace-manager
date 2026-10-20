/* window-rules-ui.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Window Rules overlay — St/Clutter UI running inside the Shell process.
 * Imported as ES module by extension.js.
 */

import Clutter from 'gi://Clutter';
import GLib   from 'gi://GLib';
import Shell  from 'gi://Shell';
import St     from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { savable } from './rules.js';

const MARGIN_PX = 24;   // kept free above and below the overlay when the screen is too short for it

const LABELS = () => ({
    class:              _('WM Class'),
    title:              _('Title'),
    onAllWorkspaces:    _('Show on all workspaces'),
    above:              _('Always on top'),
    skipTaskbar:        _('Hidden from taskbar'),
    fullscreen:         _('Fullscreen'),
    maximized:          _('Maximized'),
    geometry:           _('Geometry (%)'),
    openOnNewWorkspace: _('Open on new workspace'),
    ignore:             _('Leave alone (no tiling or moving)'),
    close:              _('Close as it opens'),
});

export class WindowRulesUI {
    constructor(extension) {
        this._ext      = extension;
        this._settings = extension._settings;
        this._widget   = null;
    }

    toggle() {
        if (this._widget) this.close();
        else this.open();
    }

    open(opts = {}) {
        if (this._widget) return;
        this._activeTab = opts.tab ?? 0;
        this._build();
        Main.layoutManager.addTopChrome(this._widget);
        this._fitHeight();
        this._switchTab(this._activeTab);
        global.stage.set_key_focus(this._widget);
    }

    close() {
        if (!this._widget) return;
        this._disconnectRefresh();
        const w = this._widget;
        this._widget = null;
        Main.layoutManager.removeChrome(w);
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { w.destroy(); return GLib.SOURCE_REMOVE; });
    }

    _disconnectRefresh() {
        this._refreshHandles?.forEach(([obj, id]) => obj.disconnect(id));
        this._refreshHandles = null;
    }

    // after the handler that asked for it: a page is never destroyed from inside one of its buttons
    _later(fn) {
        this._ext._defer(() => { if (this._widget) fn(); });
    }

    // ── Build ────────────────────────────────────────────────────────────────

    _build() {
        const monitor = Main.layoutManager.primaryMonitor;
        const W = Math.min(680, Math.round(monitor.width  * 0.55));

        this._widget = new St.BoxLayout({
            style_class: 'bwm-rules-overlay',
            vertical: true,
            reactive: true,
            can_focus: true,
            width:  W,
            x: Math.round(monitor.x + (monitor.width  - W) / 2),
        });

        // ── Header ──
        const header = new St.BoxLayout({ style_class: 'bwm-rules-header', x_expand: true });
        this._widget.add_child(header);

        header.add_child(new St.Label({
            text: _('Window Rules'),
            style_class: 'bwm-rules-title',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));

        // the form's own tab: New rule, or Edit rule while a saved one is open, highlighted then
        this._ruleBtn = new St.Button({
            label: _('New rule'),
            style_class: 'bwm-rules-tab',
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._ruleBtn.connect('clicked', () => this._showEditor(this._blankRule(null)));
        header.add_child(this._ruleBtn);

        this._tabBtns = [];
        for (const [label, idx] of [[_('Windows'), 0], [_('Rules'), 1]]) {
            const btn = new St.Button({
                label,
                style_class: 'bwm-rules-tab',
                reactive: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            btn.connect('clicked', () => this._switchTab(idx));
            header.add_child(btn);
            this._tabBtns.push(btn);
        }

        const closeBtn = new St.Button({ style_class: 'bwm-rules-close', reactive: true });
        closeBtn.set_child(new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 16 }));
        closeBtn.connect('clicked', () => this.close());
        header.add_child(closeBtn);

        this._widget.add_child(new St.Widget({ style_class: 'bwm-rules-separator', x_expand: true }));

        // ── Content area: a tab's list, or one rule's form ──
        this._contentBox = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });
        this._widget.add_child(this._contentBox);
    }

    // One height whichever page is shown, so the overlay does not grow and shrink under the user:
    // the form's, its tallest, measured once as it opens; less only when the work area is, and
    // then the page scrolls.
    _fitHeight() {
        const wa = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        // with Delete, which only a saved rule's form has; replaced by the list before it is drawn
        this._showEditor(this._blankRule(null), false);
        const [, natural] = this._widget.get_preferred_height(this._widget.width);
        const height = Math.min(natural, wa.height - 2 * MARGIN_PX);
        this._widget.height = height;
        this._widget.y = Math.round(wa.y + (wa.height - height) / 2);
    }

    _switchTab(idx) {
        this._disconnectRefresh();
        this._activeTab = idx;
        this._contentBox.destroy_all_children();
        this._ruleBtn.label = _('New rule');
        this._ruleBtn.style_class = 'bwm-rules-tab';
        this._tabBtns.forEach((b, i) => {
            b.style_class = i === idx
                ? 'bwm-rules-tab bwm-rules-tab-active'
                : 'bwm-rules-tab';
        });
        if (idx === 0) this._buildWindowsTab();
        else this._buildRulesTab();
    }

    // ── Tab 1: Windows ───────────────────────────────────────────────────────

    _buildWindowsTab() {
        const scroll = new St.ScrollView({ x_expand: true, y_expand: true, style_class: 'bwm-rules-scroll' });
        const vbox = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'bwm-rules-list' });
        scroll.set_child(vbox);
        this._contentBox.add_child(scroll);

        // a form is a page of its own, which drops these: nothing rebuilds under an edit
        const tracker = Shell.WindowTracker.get_default();
        const refresh = () => this._switchTab(0);
        this._refreshHandles = [
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', refresh)],
            [tracker, tracker.connect('tracked-windows-changed', refresh)],
        ];

        const ws = global.workspace_manager.get_active_workspace();
        const wins = ws.list_windows()
            .filter(w => this._ext._isRelevant(w) && !w.is_always_on_all_workspaces());

        if (wins.length === 0) {
            vbox.add_child(new St.Label({
                text: _('No windows on current workspace.'),
                style_class: 'bwm-rules-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        for (const win of wins)
            this._buildWindowSection(vbox, win, tracker);
    }

    _buildWindowSection(container, win, tracker) {
        const section = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'bwm-rules-section' });
        container.add_child(section);

        // Window header row
        const winRow = new St.BoxLayout({ x_expand: true, style_class: 'bwm-rules-win-row' });
        section.add_child(winRow);

        const app = tracker.get_window_app(win);
        if (app) {
            const icon = app.create_icon_texture(32);
            icon.style_class = 'bwm-rules-win-icon';
            winRow.add_child(icon);
        }

        const labels = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        const titleStr = win.get_title() ?? '';
        labels.add_child(new St.Label({
            text: titleStr.length > 60 ? titleStr.slice(0, 60) + '…' : (titleStr || (win.get_wm_class() ?? '')),
            style_class: 'bwm-rules-win-class',
        }));
        const cls = win.get_wm_class() ?? '';
        if (cls) labels.add_child(new St.Label({ text: cls, style_class: 'bwm-rules-win-title' }));
        winRow.add_child(labels);

        // Applied rules
        const applied = this._ext._appliedRules(win);
        for (const rule of this._getRules()) {
            if (applied.has(rule.id)) this._appendRuleRow(section, rule);
        }

        // New rule, started from this window
        const newBtn = new St.Button({
            label: _('+ New rule for this window'),
            style_class: 'bwm-rules-new-btn',
            x_align: Clutter.ActorAlign.START,
            reactive: true,
        });
        newBtn.connect('clicked', () => this._later(() => this._showEditor(this._blankRule(win))));
        section.add_child(newBtn);
    }

    // ── Tab 2: All rules ─────────────────────────────────────────────────────

    _buildRulesTab() {
        const scroll = new St.ScrollView({ x_expand: true, y_expand: true, style_class: 'bwm-rules-scroll' });
        const vbox = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'bwm-rules-list' });
        scroll.set_child(vbox);
        this._contentBox.add_child(scroll);

        for (const rule of this._getRules())
            this._appendRuleRow(vbox, rule);
    }

    // A rule as a line of its list; pressed, it opens its form in place of the list.
    _appendRuleRow(container, rule) {
        const rowBox = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'bwm-rules-rule-row' });
        container.add_child(rowBox);
        const summaryRow = new St.BoxLayout({ x_expand: true, reactive: true, style_class: 'bwm-rules-summary-row' });
        rowBox.add_child(summaryRow);
        summaryRow.add_child(new St.Label({
            text: this._ruleSummary(rule),
            style_class: 'bwm-rules-summary-text',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        summaryRow.add_child(new St.Label({ text: '▶', style_class: 'bwm-rules-chevron', y_align: Clutter.ActorAlign.CENTER }));
        summaryRow.connect('button-press-event', () => {
            this._later(() => this._showEditor(rule));
            return Clutter.EVENT_STOP;
        });
    }

    // ── Rule form ────────────────────────────────────────────────────────────

    // In place of the list, its own header button highlighted: either tab leaves it, as Cancel
    // does. isNew: a rule not saved yet, whose form has no Delete.
    _showEditor(rule, isNew = !this._getRules().some(r => r.id === rule.id)) {
        this._disconnectRefresh();
        this._contentBox.destroy_all_children();
        this._tabBtns.forEach(b => { b.style_class = 'bwm-rules-tab'; });
        this._ruleBtn.label = isNew ? _('New rule') : _('Edit rule');
        this._ruleBtn.style_class = 'bwm-rules-tab bwm-rules-tab-active';
        const scroll = new St.ScrollView({ x_expand: true, y_expand: true, style_class: 'bwm-rules-scroll' });
        const form = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'bwm-rules-detail' });
        scroll.set_child(form);
        this._contentBox.add_child(scroll);
        this._populateEditor(form, rule, isNew, () => this._later(() => this._switchTab(this._activeTab)));
    }

    // onDone: back to the list the form was opened from, whichever button ended it
    _populateEditor(box, rule, isNew, onDone) {
        const draft   = JSON.parse(JSON.stringify(rule));
        const summary = new St.Label({ text: this._ruleSummary(draft), style_class: 'bwm-rules-summary-text' });
        box.add_child(summary);
        let saveBtn = null;
        // Save only for a rule that picks windows and whose patterns are patterns (rules#savable)
        const refresh = () => {
            summary.text = this._ruleSummary(draft);
            if (saveBtn) saveBtn.reactive = savable(draft);
        };

        // Ensure all action fields exist (rules saved before new actions were added)
        draft.actions.onAllWorkspaces    ??= { enabled: false, value: true };
        draft.actions.above              ??= { enabled: false, value: true };
        draft.actions.openOnNewWorkspace ??= { enabled: false, value: true };
        draft.actions.ignore             ??= { enabled: false, value: true };
        draft.actions.close              ??= { enabled: false, value: true };
        draft.actions.geometry           ??= { enabled: false, x: 0, y: 0, w: 50, h: 50 };

        // Conditions
        box.add_child(new St.Label({ text: _('Conditions'), style_class: 'bwm-rules-section-label' }));
        for (const key of ['class', 'title'])
            box.add_child(this._makeRegexRow(key, draft.conditions[key], refresh));
        for (const key of ['onAllWorkspaces', 'above', 'skipTaskbar', 'fullscreen', 'maximized'])
            box.add_child(this._makeBoolCondRow(key, draft.conditions[key], refresh));

        // Actions
        box.add_child(new St.Label({ text: _('Actions'), style_class: 'bwm-rules-section-label' }));
        for (const key of ['onAllWorkspaces', 'above', 'openOnNewWorkspace', 'ignore', 'close'])
            box.add_child(this._makeActionBoolRow(key, draft.actions[key], refresh));
        box.add_child(this._makeGeomRow(draft.actions.geometry, refresh));

        // Buttons: Save and Cancel, Delete apart on the other side
        const btnRow = new St.BoxLayout({ style_class: 'bwm-rules-btn-row', x_expand: true });
        box.add_child(btnRow);

        saveBtn = new St.Button({ label: _('Save'), style_class: 'bwm-rules-save-btn', reactive: savable(draft) });
        saveBtn.connect('clicked', () => {
            if (!savable(draft)) return;
            const rules = this._getRules();
            const idx   = rules.findIndex(r => r.id === draft.id);
            if (idx >= 0) rules[idx] = draft;
            else rules.push(draft);
            this._saveRules(rules);
            this._ext._applyRuleToAll(draft);
            onDone();
        });
        btnRow.add_child(saveBtn);

        const cancelBtn = new St.Button({ label: _('Cancel'), style_class: 'bwm-rules-cancel-btn', reactive: true });
        cancelBtn.connect('clicked', () => onDone());
        btnRow.add_child(cancelBtn);

        if (!isNew) {
            btnRow.add_child(new St.Widget({ x_expand: true }));
            const delBtn = new St.Button({ label: _('Delete'), style_class: 'bwm-rules-del-btn', reactive: true });
            delBtn.connect('clicked', () => {
                this._saveRules(this._getRules().filter(r => r.id !== rule.id));
                onDone();
            });
            btnRow.add_child(delBtn);
        }
    }

    // ── Row builders ─────────────────────────────────────────────────────────

    _makeRegexRow(key, cond, onChange) {
        const row = new St.BoxLayout({ style_class: 'bwm-rules-row', x_expand: true });
        row.add_child(this._makeToggle(cond.enabled, v => { cond.enabled = v; onChange?.(); }));
        row.add_child(new St.Label({ text: LABELS()[key] ?? key, style_class: 'bwm-rules-row-label', y_align: Clutter.ActorAlign.CENTER }));
        const entry = new St.Entry({ text: cond.regex ?? '', style_class: 'bwm-rules-entry', x_expand: true });
        entry.get_clutter_text().connect('text-changed', () => {
            const val = entry.get_text();
            try   { new RegExp(val); entry.remove_style_class_name('bwm-entry-error'); }
            catch { entry.add_style_class_name('bwm-entry-error'); }
            cond.regex = val;
            onChange?.();
        });
        row.add_child(entry);
        return row;
    }

    _makeBoolCondRow(key, cond, onChange) {
        const row = new St.BoxLayout({ style_class: 'bwm-rules-row', x_expand: true });
        row.add_child(this._makeToggle(cond.enabled, v => { cond.enabled = v; onChange?.(); }));
        row.add_child(new St.Label({ text: LABELS()[key] ?? key, style_class: 'bwm-rules-row-label', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        // value is always true — we match windows that HAVE this property set
        return row;
    }

    _makeActionBoolRow(key, action, onChange) {
        const row = new St.BoxLayout({ style_class: 'bwm-rules-row', x_expand: true });
        row.add_child(this._makeToggle(action.enabled, v => { action.enabled = v; onChange?.(); }));
        row.add_child(new St.Label({ text: LABELS()[key] ?? key, style_class: 'bwm-rules-row-label', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        // value is always true — enable toggle is sufficient
        return row;
    }

    _makeGeomRow(geom, onChange) {
        const box = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'bwm-rules-geom-box' });

        const headerRow = new St.BoxLayout({ style_class: 'bwm-rules-row', x_expand: true });
        headerRow.add_child(this._makeToggle(geom.enabled, v => { geom.enabled = v; onChange?.(); }));
        headerRow.add_child(new St.Label({ text: LABELS().geometry, style_class: 'bwm-rules-row-label', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        box.add_child(headerRow);

        const fieldsRow = new St.BoxLayout({ style_class: 'bwm-rules-geom-row', x_expand: true });
        for (const f of ['x', 'y', 'w', 'h']) {
            fieldsRow.add_child(new St.Label({ text: f + ':', style_class: 'bwm-rules-geom-label', y_align: Clutter.ActorAlign.CENTER }));
            const entry = new St.Entry({ text: String(geom[f] ?? 0), style_class: 'bwm-rules-geom-entry' });
            entry.get_clutter_text().connect('text-changed', () => {
                const v = parseFloat(entry.get_text());
                if (!isNaN(v)) geom[f] = Math.max(0, Math.min(100, v));
            });
            fieldsRow.add_child(entry);
        }
        box.add_child(fieldsRow);
        return box;
    }

    _makeToggle(initial, onChange) {
        const btn = new St.Button({
            label: initial ? _('ON') : _('OFF'),
            style_class: initial ? 'bwm-toggle bwm-toggle-on' : 'bwm-toggle',
            reactive: true,
        });
        let state = initial;
        btn.connect('clicked', () => {
            state = !state;
            btn.label      = state ? _('ON') : _('OFF');
            btn.style_class = state ? 'bwm-toggle bwm-toggle-on' : 'bwm-toggle';
            onChange(state);
        });
        return btn;
    }

    // ── Data helpers ─────────────────────────────────────────────────────────

    _getRules() {
        try   { return JSON.parse(this._settings.get_string('window-rules')); }
        catch { return []; }
    }

    _saveRules(rules) {
        this._settings.set_string('window-rules', JSON.stringify(rules));
    }

    _blankRule(win) {
        const wa = win ? win.get_work_area_current_monitor() : null;
        const r  = win ? win.get_frame_rect() : null;
        return {
            id: GLib.uuid_string_random(),
            conditions: {
                class:           { enabled: true,  regex: win?.get_wm_class() ?? '' },
                title:           { enabled: false, regex: win?.get_title()    ?? '' },
                onAllWorkspaces: { enabled: false, value: false },
                above:           { enabled: false, value: false },
                skipTaskbar:     { enabled: false, value: false },
                fullscreen:      { enabled: false, value: false },
                maximized:       { enabled: false, value: false },
            },
            actions: {
                onAllWorkspaces:    { enabled: false, value: true },
                above:              { enabled: false, value: true },
                openOnNewWorkspace: { enabled: false, value: true },
                ignore:             { enabled: false, value: true },
                close:              { enabled: false, value: true },
                geometry: {
                    enabled: false,
                    x: wa ? Math.round(100 * (r.x - wa.x) / wa.width)  : 0,
                    y: wa ? Math.round(100 * (r.y - wa.y) / wa.height) : 0,
                    w: wa ? Math.round(100 * r.width  / wa.width)  : 50,
                    h: wa ? Math.round(100 * r.height / wa.height) : 50,
                },
            },
        };
    }

    _ruleSummary(rule) {
        const conds = Object.entries(rule.conditions)
            .filter(([, c]) => c.enabled)
            .map(([k, c]) => c.regex !== undefined ? `${k}~${c.regex}` : `${k}=${c.value}`)
            .join(', ');
        const acts = Object.entries(rule.actions)
            .filter(([, a]) => a.enabled)
            .map(([k]) => k === 'geometry' ? 'geom' : (LABELS()[k] ?? k))
            .join(', ');
        return (conds || _('(no conditions)')) + '  →  ' + (acts || _('(no actions)'));
    }
}
