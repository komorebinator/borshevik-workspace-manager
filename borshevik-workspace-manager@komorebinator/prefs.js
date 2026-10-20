/* prefs.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { formatReport } from './perf.js';

const DEBUG_LOGGING = 'debug-logging';
// how much of the debug log Copy takes: a bug just seen, small enough for a bug report
const DEBUG_LOG_MINUTES = 10;

// the extension's own object, exported in GNOME Shell (extension.js)
const callExtension = (method, onReply) => Gio.DBus.session.call(
    'org.gnome.Shell', '/org/borshevik/WorkspaceManager', 'org.borshevik.WorkspaceManager', method,
    null, null, Gio.DBusCallFlags.NONE, -1, null, (bus, res) => {
        let reply = null, error = null;
        try { reply = bus.call_finish(res); } catch (e) { error = e; }
        onReply(reply, error);
    });

// The extension's own entries of the journal for the last DEBUG_LOG_MINUTES, each whole: its debug
// log; an error it threw, whose stack trace names one of its files; one GNOME reports of it, loading
// it say. An entry runs over the lines after its first that are indented. The journal is read here,
// the shell having nothing of it: the user's own, which needs no group to read.
function readDebugLog(uuid, onDone) {
    let proc;
    try {
        proc = Gio.Subprocess.new(
            ['journalctl', '--user', '-b', '-o', 'short-iso', '_COMM=gnome-shell', '--since', `-${DEBUG_LOG_MINUTES}min`],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        onDone(null, e);
        return;
    }
    proc.communicate_utf8_async(null, null, (p, res) => {
        let out;
        try { [, out] = p.communicate_utf8_finish(res); } catch (e) { onDone(null, e); return; }
        const entries = [];
        for (const line of out.split('\n')) {
            if (/^\s/.test(line) && entries.length) entries.at(-1).push(line);
            else if (line) entries.push([line]);
        }
        const ours = entry => {
            const text = entry.join('\n');
            return text.includes('[BWM]') || text.includes(`/${uuid}/`) || (text.includes(uuid) && /error/i.test(text));
        };
        onDone(entries.filter(ours).flat());
    });
}

const copyText = (window, text) => {
    const bytes = new GLib.Bytes(new TextEncoder().encode(text));
    window.get_clipboard().set_content(Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytes));
};

export default class Preferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const _ = this.gettext.bind(this);
        const settings = this.getSettings();

        const page  = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();

        // button: one more suffix before the switch, usable only while the switch is on
        const addToggle = (title, key, to = group, subtitle = '', button = null) => {
            const row    = new Adw.ActionRow({ title, subtitle });
            if (button) {
                settings.bind(key, button, 'sensitive', Gio.SettingsBindFlags.GET);
                row.add_suffix(button);
            }
            const toggle = new Gtk.Switch({ active: settings.get_boolean(key), valign: Gtk.Align.CENTER });
            settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
            row.add_suffix(toggle);
            row.activatable_widget = toggle;
            to.add(row);
        };

        addToggle(_('Open overview on last workspace'), 'overview-on-last-workspace');

        // on-empty-workspace combo
        const emptyWsKeys   = ['prev', 'overview', 'nothing'];
        const emptyWsLabels = [_('Go back'), _('Open overview'), _('Do nothing')];
        const emptyWsRow    = new Adw.ComboRow({ title: _('When last window on workspace closes') });
        const emptyWsModel  = new Gtk.StringList();
        emptyWsLabels.forEach(s => emptyWsModel.append(s));
        emptyWsRow.model    = emptyWsModel;
        emptyWsRow.selected = Math.max(0, emptyWsKeys.indexOf(settings.get_string('on-empty-workspace')));
        emptyWsRow.connect('notify::selected', () => {
            settings.set_string('on-empty-workspace', emptyWsKeys[emptyWsRow.selected]);
        });
        group.add(emptyWsRow);

        page.add(group);

        // what is there to find out what the extension does: its log, and what it costs
        const debugGroup = new Adw.PreferencesGroup({ title: _('Debug') });
        const toast = title => window.add_toast(new Adw.Toast({ title }));
        const copyButton = onClick => {
            const button = new Gtk.Button({ label: _('Copy'), valign: Gtk.Align.CENTER });
            button.connect('clicked', onClick);
            return button;
        };

        const copyLog = copyButton(() => readDebugLog(this.uuid, (lines, error) => {
            if (error) {
                toast(_('The journal could not be read'));
                return;
            }
            if (!lines.length) {
                toast(_('The debug log is empty'));
                return;
            }
            copyText(window, [`Borshevik Workspace Manager — debug log, the last ${DEBUG_LOG_MINUTES} minutes`,
                '', ...lines].join('\n'));
            toast(_('Debug log copied'));
        }));
        addToggle(_('Debug logging'), DEBUG_LOGGING, debugGroup,
            _('Writes what the extension does to the journal. Copy takes the last %d minutes of it.')
                .replace('%d', DEBUG_LOG_MINUTES), copyLog);

        const copyReport = copyButton(() => callExtension('GetPerfReport', (reply, error) => {
            if (error) {
                toast(_('The extension is not running'));
                return;
            }
            copyText(window, formatReport(JSON.parse(reply.deep_unpack()[0])));
            toast(_('Performance report copied'));
        }));
        addToggle(_('Performance log'), 'perf-log', debugGroup,
            _('Counts how often the extension acts and how long it takes. Switching it on starts a new report; Copy takes it.'),
            copyReport);
        page.add(debugGroup);

        window.add(page);
    }
}
