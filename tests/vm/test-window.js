// A window for the scenarios (tests/vm/run.js): one per process, titled with its name and with
// the app id org.borshevik.Test.<app>, so a test window is told apart by wm_class and window
// rules can match it. Runs as tester in the test machine under gjs.
//
//   gjs -m test-window.js <name> [width height] [--min-width px]
//                         [--maximized] [--fullscreen] [--app id] [--stall ms]
//
// --stall: an app slow to start — once shown, the window answers nothing for that long, so GNOME
// has it neither sized nor drawn (behaviour#role-by-size#slow-to-open).
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
const appName = option('--app');
const stall = Number(option('--stall') ?? 0);
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
    if (minWidth > 0) label.set_size_request(minWidth, -1);
    win.set_child(label);
    if (maximized) win.maximize();
    if (fullscreen) win.fullscreen();
    win.present();
    // before GTK has taken the size GNOME sends: the window exists there, still 0x0, undrawn
    if (stall) GLib.idle_add(GLib.PRIORITY_HIGH, () => { GLib.usleep(stall * 1000); return GLib.SOURCE_REMOVE; });
});
app.run([]);
