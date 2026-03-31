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

const LABELS = {
    class:              'WM Class',
    title:              'Title',
    onAllWorkspaces:    'Show on all workspaces',
    above:              'Always on top',
    skipTaskbar:        'Hidden from taskbar',
    fullscreen:         'Fullscreen',
    maximized:          'Maximized',
    geometry:           'Geometry (%)',
    openOnNewWorkspace: 'Open on new workspace',
};

export class WindowRulesUI {
    constructor(extension) {
        this._ext      = extension;
        this._settings = extension._settings;
        this._widget   = null;
        this._modalPushed = false;
    }

    toggle() {
        if (this._widget) this.close();
        else this.open();
    }

    open(opts = {}) {
        if (this._widget) return;
        this._initialTab = opts.tab ?? 0;
        this._isEditing  = false;
        this._build();
        Main.layoutManager.addTopChrome(this._widget);
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

    // ── Build ────────────────────────────────────────────────────────────────

    _build() {
        const monitor = Main.layoutManager.primaryMonitor;
        const W = Math.min(680, Math.round(monitor.width  * 0.55));
        const H = Math.min(580, Math.round(monitor.height * 0.72));

        this._widget = new St.BoxLayout({
            style_class: 'bwm-rules-overlay',
            vertical: true,
            reactive: true,
            can_focus: true,
            width:  W,
            height: H,
            x: Math.round(monitor.x + (monitor.width  - W) / 2),
            y: Math.round(monitor.y + (monitor.height - H) / 2),
        });

        // ── Header ──
        const header = new St.BoxLayout({ style_class: 'bwm-rules-header', x_expand: true });
        this._widget.add_child(header);

        header.add_child(new St.Label({
            text: 'Window Rules',
            style_class: 'bwm-rules-title',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));

        this._tabBtns = [];
        for (const [label, idx] of [['Windows', 0], ['Rules', 1]]) {
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

        // ── Content area ──
        this._contentBox = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });
        this._widget.add_child(this._contentBox);

        this._switchTab(this._initialTab);
    }

    _switchTab(idx) {
        this._disconnectRefresh();
        this._isEditing = false;
        this._activeTab = idx;
        this._contentBox.destroy_all_children();
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

        const tracker = Shell.WindowTracker.get_default();
        const refresh = () => { if (!this._isEditing) this._switchTab(0); };
        this._refreshHandles = [
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', refresh)],
            [tracker, tracker.connect('tracked-windows-changed', refresh)],
        ];

        const ws = global.workspace_manager.get_active_workspace();
        const wins = ws.list_windows()
            .filter(w => this._ext._isRelevant(w) && !w.is_always_on_all_workspaces());

        if (wins.length === 0) {
            vbox.add_child(new St.Label({
                text: 'No windows on current workspace.',
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
        const rules   = this._getRules();
        const applied = win._bwmAppliedRules ?? new Set();
        for (const rule of rules) {
            if (!applied.has(rule.id)) continue;
            this._appendRuleRow(section, rule, win);
        }

        // New rule button
        const newBtn = new St.Button({
            label: '+ New rule for this window',
            style_class: 'bwm-rules-new-btn',
            x_align: Clutter.ActorAlign.START,
            reactive: true,
        });
        newBtn.connect('clicked', () => {
            this._isEditing = true;
            section.remove_child(newBtn);
            this._appendRuleRow(section, this._blankRule(win), win, true);
        });
        section.add_child(newBtn);
    }

    // ── Tab 2: All rules ─────────────────────────────────────────────────────

    _buildRulesTab() {
        const scroll = new St.ScrollView({ x_expand: true, y_expand: true, style_class: 'bwm-rules-scroll' });
        const vbox = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'bwm-rules-list' });
        scroll.set_child(vbox);
        this._contentBox.add_child(scroll);

        const newBtn = new St.Button({
            label: '+ New rule',
            style_class: 'bwm-rules-new-btn',
            x_align: Clutter.ActorAlign.START,
            reactive: true,
        });
        newBtn.connect('clicked', () => {
            this._isEditing = true;
            this._appendRuleRow(vbox, this._blankRule(null), null, true, newBtn);
        });
        vbox.add_child(newBtn);

        for (const rule of this._getRules())
            this._appendRuleRow(vbox, rule, null);
    }

    // ── Inline rule row (accordion) ──────────────────────────────────────────

    _appendRuleRow(container, rule, win, startExpanded = false, insertBefore = null) {
        const isNew = !this._getRules().find(r => r.id === rule.id);

        const rowBox = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'bwm-rules-rule-row' });
        if (insertBefore)
            container.insert_child_below(rowBox, insertBefore);
        else
            container.add_child(rowBox);

        // Collapsed summary row
        const summaryRow = new St.BoxLayout({ x_expand: true, reactive: true, style_class: 'bwm-rules-summary-row' });
        rowBox.add_child(summaryRow);

        const summaryLabel = new St.Label({
            text: this._ruleSummary(rule),
            style_class: 'bwm-rules-summary-text',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        summaryRow.add_child(summaryLabel);

        const chevron = new St.Label({
            text: startExpanded ? '▼' : '▶',
            style_class: 'bwm-rules-chevron',
            y_align: Clutter.ActorAlign.CENTER,
        });
        summaryRow.add_child(chevron);

        // Detail editor box
        const detailBox = new St.BoxLayout({
            vertical: true, x_expand: true,
            style_class: 'bwm-rules-detail',
            visible: startExpanded,
        });
        rowBox.add_child(detailBox);

        const collapse = () => {
            detailBox.visible = false;
            chevron.text = '▶';
            detailBox.destroy_all_children();
        };

        if (startExpanded)
            this._populateEditor(detailBox, rule, win, summaryLabel, isNew, collapse);

        summaryRow.connect('button-press-event', () => {
            const show = !detailBox.visible;
            detailBox.visible = show;
            chevron.text = show ? '▼' : '▶';
            if (show) {
                this._isEditing = true;
                detailBox.destroy_all_children();
                this._populateEditor(detailBox, rule, win, summaryLabel, isNew, collapse);
            } else {
                this._isEditing = false;
            }
            return Clutter.EVENT_STOP;
        });
    }

    // ── Rule editor ──────────────────────────────────────────────────────────

    _populateEditor(box, rule, _win, summaryLabel, isNew, onCollapse) {
        const draft   = JSON.parse(JSON.stringify(rule));
        const refresh = () => { summaryLabel.text = this._ruleSummary(draft); };

        // Ensure all action fields exist (rules saved before new actions were added)
        draft.actions.onAllWorkspaces    ??= { enabled: false, value: true };
        draft.actions.above              ??= { enabled: false, value: true };
        draft.actions.openOnNewWorkspace ??= { enabled: false, value: true };
        draft.actions.geometry           ??= { enabled: false, x: 0, y: 0, w: 50, h: 50 };

        // Conditions
        box.add_child(new St.Label({ text: 'Conditions', style_class: 'bwm-rules-section-label' }));
        for (const key of ['class', 'title'])
            box.add_child(this._makeRegexRow(key, draft.conditions[key], refresh));
        for (const key of ['onAllWorkspaces', 'above', 'skipTaskbar', 'fullscreen', 'maximized'])
            box.add_child(this._makeBoolCondRow(key, draft.conditions[key]));

        // Actions
        box.add_child(new St.Label({ text: 'Actions', style_class: 'bwm-rules-section-label' }));
        for (const key of ['onAllWorkspaces', 'above', 'openOnNewWorkspace'])
            box.add_child(this._makeActionBoolRow(key, draft.actions[key]));
        box.add_child(this._makeGeomRow(draft.actions.geometry));

        // Buttons
        const btnRow = new St.BoxLayout({ style_class: 'bwm-rules-btn-row', x_expand: true });
        box.add_child(btnRow);

        const saveBtn = new St.Button({ label: 'Save', style_class: 'bwm-rules-save-btn', reactive: true });
        saveBtn.connect('clicked', () => {
            if (!this._hasEnabledCondition(draft)) return;
            const rules = this._getRules();
            const idx   = rules.findIndex(r => r.id === draft.id);
            if (idx >= 0) rules[idx] = draft;
            else rules.push(draft);
            this._saveRules(rules);
            this._ext._applyRuleToAll(draft);
            this._isEditing = false;
            onCollapse?.();
            const tab = this._activeTab;
            this._ext._defer(() => { if (this._widget) this._switchTab(tab); });
        });
        btnRow.add_child(saveBtn);

        const cancelBtn = new St.Button({ label: 'Cancel', style_class: 'bwm-rules-cancel-btn', reactive: true });
        cancelBtn.connect('clicked', () => {
            this._isEditing = false;
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { onCollapse?.(); return GLib.SOURCE_REMOVE; });
        });
        btnRow.add_child(cancelBtn);

        if (!isNew) {
            btnRow.add_child(new St.Widget({ x_expand: true }));
            const delBtn = new St.Button({ label: 'Delete', style_class: 'bwm-rules-del-btn', reactive: true });
            delBtn.connect('clicked', () => {
                const rules = this._getRules().filter(r => r.id !== rule.id);
                this._saveRules(rules);
                box.get_parent().destroy();
            });
            btnRow.add_child(delBtn);
        }
    }

    // ── Row builders ─────────────────────────────────────────────────────────

    _makeRegexRow(key, cond, onChange) {
        const row = new St.BoxLayout({ style_class: 'bwm-rules-row', x_expand: true });
        row.add_child(this._makeToggle(cond.enabled, v => { cond.enabled = v; }));
        row.add_child(new St.Label({ text: LABELS[key] ?? key, style_class: 'bwm-rules-row-label', y_align: Clutter.ActorAlign.CENTER }));
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

    _makeBoolCondRow(key, cond) {
        const row = new St.BoxLayout({ style_class: 'bwm-rules-row', x_expand: true });
        row.add_child(this._makeToggle(cond.enabled, v => { cond.enabled = v; }));
        row.add_child(new St.Label({ text: LABELS[key] ?? key, style_class: 'bwm-rules-row-label', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        // value is always true — we match windows that HAVE this property set
        return row;
    }

    _makeActionBoolRow(key, action) {
        const row = new St.BoxLayout({ style_class: 'bwm-rules-row', x_expand: true });
        row.add_child(this._makeToggle(action.enabled, v => { action.enabled = v; }));
        row.add_child(new St.Label({ text: LABELS[key] ?? key, style_class: 'bwm-rules-row-label', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        // value is always true — enable toggle is sufficient
        return row;
    }

    _makeGeomRow(geom) {
        const box = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'bwm-rules-geom-box' });

        const headerRow = new St.BoxLayout({ style_class: 'bwm-rules-row', x_expand: true });
        headerRow.add_child(this._makeToggle(geom.enabled, v => { geom.enabled = v; }));
        headerRow.add_child(new St.Label({ text: LABELS.geometry, style_class: 'bwm-rules-row-label', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
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
            label: initial ? 'ON' : 'OFF',
            style_class: initial ? 'bwm-toggle bwm-toggle-on' : 'bwm-toggle',
            reactive: true,
        });
        let state = initial;
        btn.connect('clicked', () => {
            state = !state;
            btn.label      = state ? 'ON' : 'OFF';
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
            .map(([k]) => k === 'geometry' ? 'geom' : (LABELS[k] ?? k))
            .join(', ');
        return (conds || '(no conditions)') + '  →  ' + (acts || '(no actions)');
    }

    _hasEnabledCondition(rule) {
        return Object.values(rule.conditions).some(c => c.enabled);
    }
}
