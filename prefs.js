/* prefs.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Adw from "gi://Adw";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";
import { ExtensionPreferences } from 'resource:///org/gnome/shell/extensions/prefs.js';

const MOVE_WINDOW_WHEN_MAXIMIZED = 'move-window-when-maximized';

export default class Preferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();

        const row = new Adw.ActionRow({ title: 'Move window when maximized' });

        const toggle = new Gtk.Switch({
            active: settings.get_boolean(MOVE_WINDOW_WHEN_MAXIMIZED),
            valign: Gtk.Align.CENTER,
        });

        settings.bind(
            MOVE_WINDOW_WHEN_MAXIMIZED,
            toggle,
            'active',
            Gio.SettingsBindFlags.DEFAULT,
        );

        row.add_suffix(toggle);
        row.activatable_widget = toggle;
        group.add(row);
        page.add(group);
        window.add(page);
    }
}
