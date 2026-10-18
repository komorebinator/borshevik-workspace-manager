// A window for the scenarios (tests/vm/run.js): one per process, titled with its name and with
// the app id org.borshevik.Test.<app>, so a test window is told apart by wm_class and window
// rules can match it. Runs as tester in the test machine under gjs.
//
//   gjs -m test-window.js <name> [width height] [--min-width px [--min-width-after ms]]
//                         [--maximized] [--fullscreen] [--app id]
//
// --min-width-after: a slow app — the smallest width holds only that long after the window was
// made narrower than it, and until then the window takes any width it is given.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const args = [...System.programArgs];
const flag = f => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
const option = f => { const i = args.indexOf(f); if (i < 0) return null; const [, v] = args.splice(i, 2); return v; };

const maximized = flag('--maximized');
const fullscreen = flag('--fullscreen');
const minWidth = Number(option('--min-width') ?? 0);
const minWidthAfter = Number(option('--min-width-after') ?? 0);
const appName = option('--app');
const [name, width = '400', height = '300'] = args;

const app = new Gtk.Application({
    application_id: `org.borshevik.Test.${appName ?? name}`,
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
    const win = new Gtk.ApplicationWindow({
        application: app, title: name,
        default_width: Number(width), default_height: Number(height),
    });
    const label = new Gtk.Label({ label: name, css_classes: ['title-1'] });
    // a window cannot be made narrower than its content: this is how a smallest width is had
    if (minWidth > 0 && !minWidthAfter) label.set_size_request(minWidth, -1);
    if (minWidth > 0 && minWidthAfter) {
        let pending = false;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (!pending && win.get_width() > 0 && win.get_width() < minWidth) {
                pending = true;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, minWidthAfter, () => {
                    label.set_size_request(minWidth, -1);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return GLib.SOURCE_CONTINUE;
        });
    }
    win.set_child(label);
    if (maximized) win.maximize();
    if (fullscreen) win.fullscreen();
    win.present();
});
app.run([]);
