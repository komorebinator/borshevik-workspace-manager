/* prefs.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Adw from "gi://Adw";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MOVE_WINDOW_WHEN_MAXIMIZED = 'move-window-when-maximized';
const DEBUG_LOGGING               = 'debug-logging';

export default class Preferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page  = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();

        const addToggle = (title, key) => {
            const row    = new Adw.ActionRow({ title });
            const toggle = new Gtk.Switch({ active: settings.get_boolean(key), valign: Gtk.Align.CENTER });
            settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
            row.add_suffix(toggle);
            row.activatable_widget = toggle;
            group.add(row);
        };

        addToggle('Move window when maximized', MOVE_WINDOW_WHEN_MAXIMIZED);
        addToggle('Debug logging',              DEBUG_LOGGING);

        page.add(group);
        window.add(page);
    }
}
