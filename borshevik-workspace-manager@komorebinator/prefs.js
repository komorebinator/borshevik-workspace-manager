/* prefs.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Adw from "gi://Adw";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DEBUG_LOGGING = 'debug-logging';

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

        addToggle('Open overview on last workspace', 'overview-on-last-workspace');
        addToggle('Debug logging',                   DEBUG_LOGGING);

        // on-empty-workspace combo
        const emptyWsKeys   = ['prev', 'overview', 'nothing'];
        const emptyWsLabels = ['Go back', 'Open overview', 'Do nothing'];
        const emptyWsRow    = new Adw.ComboRow({ title: 'When last window on workspace closes' });
        const emptyWsModel  = new Gtk.StringList();
        emptyWsLabels.forEach(s => emptyWsModel.append(s));
        emptyWsRow.model    = emptyWsModel;
        emptyWsRow.selected = Math.max(0, emptyWsKeys.indexOf(settings.get_string('on-empty-workspace')));
        emptyWsRow.connect('notify::selected', () => {
            settings.set_string('on-empty-workspace', emptyWsKeys[emptyWsRow.selected]);
        });
        group.add(emptyWsRow);

        page.add(group);
        window.add(page);
    }
}
