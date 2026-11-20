// SPDX-License-Identifier: GPL-3.0-or-later
//
// The indicator's styles stand: puts variants of the panel indicator's look on the test
// machine's panel one after another — a stylesheet loaded over the extension's own and a
// change to the buttons' actors — photographs the indicator in the light and the dark case,
// and lays the photographs out on one sheet per group, a row per variant, for the author to
// judge, or puts one variant on the panel to be looked at live (`show`). Nothing is checked.
// Run on the host by `gjs -m tests/vm/indicator-styles.js [filter | show <variant>]`, with the
// machine started and the working tree deployed; it opens a few apps' windows over the
// workspaces itself. The sheets land in the machine's directory, bwm-styles/<group>.png.

import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Gdk from 'gi://Gdk?version=4.0';
import Cairo from 'cairo';
import System from 'system';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const vmScript = `${GLib.path_get_dirname(here)}/vm.sh`;
const machineDir = `${GLib.getenv('XDG_CACHE_HOME') ?? `${GLib.get_home_dir()}/.cache`}/borshevik-extensions-vm`;
const outDir = `${machineDir}/bwm-styles`;
GLib.mkdir_with_parents(`${outDir}/shots`, 0o755);

const CASES = ['light', 'dark'];
const MARGIN = 8;
const SCALE = 2;   // the photographs are small; drawn twice their size on the sheet

function run(argv) {
    const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [, out, err] = proc.communicate_utf8(null, null);
    if (!proc.get_successful())
        throw new Error(`${argv.join(' ')}: ${(err || out).trim()}`);
    return out;
}
const vm = (...args) => run(['bash', vmScript, ...args]);
const evalJs = js => vm('eval', js).trim();
const sleep = seconds => GLib.usleep(seconds * 1e6);

// The active workspace's outline at another strength than the stylesheet's.
const outline = alpha => `
    #panel .bwm-ws-bg.bwm-ws-active {
        border-color: st-transparentize(-st-accent-color, ${1 - alpha});
    }`;

// Each group: variants of one thing, the first of them as the extension has it now. A
// variant is a stylesheet loaded over the extension's (css); how much other workspaces'
// icons are greyed (grey, 0..1) and their contrast lowered (contrast, -1..0); how opaque
// their buttons are (opacity, 0..255) and how big their icons (small, px); the '+' icon's
// size and slot (plus); and whether the '+' is under the pointer (hover).
const GROUPS = [
    {
        id: 'outline',
        variants: [
            {label: 'now: 2 px, accent 60 %'},
            {label: 'accent 40 %', css: outline(0.4)},
            {label: 'accent 80 %', css: outline(0.8)},
            {label: 'accent 100 %', css: outline(1)},
        ],
    },
    {
        // how the other workspaces are set back
        id: 'dim',
        variants: [
            {label: 'now: colour, opacity 90 %'},
            {label: 'colour, opacity 100 %', opacity: 255},
            {label: 'colour, opacity 80 %', opacity: 204},
            {label: 'colour, opacity 70 %', opacity: 179},
            {label: 'grey 100 %, opacity 80 %', grey: 1, opacity: 204},
            {label: 'grey 60 %, opacity 80 %', grey: 0.6, opacity: 204},
            {label: 'grey 30 %, opacity 60 %', grey: 0.3, opacity: 153},
            {label: 'contrast −30 %, opacity 80 %', contrast: -0.3, opacity: 204},
            {label: 'colour, 18 px, opacity 80 %', small: 18, opacity: 204},
        ],
    },
    {
        id: 'plus',
        // the '+' workspace the active one, so its button shows its background and outline
        activate: 'last',
        variants: [
            {label: 'now: 16 px in a 22 px slot'},
            {label: '14 px, no slot', plus: {size: 14, slot: 14}},
            {label: '14 px in a 22 px slot', plus: {size: 14}},
            {label: '18 px in a 22 px slot', plus: {size: 18}},
            {label: 'now, under the pointer', hover: true},
        ],
    },
];

// What the extension has now, for what a variant leaves out.
const NOW = {css: '', grey: 0, contrast: 0, opacity: 230, small: 22, plus: {size: 16, slot: -1}, hover: false};

// The variant put on the running shell: the stylesheet loaded in place of the last one, and
// the buttons changed as the view would have made them. The running view's _setActive is
// wrapped so a workspace switched to or from keeps the variant until the next one, or the
// next deploy.
function apply(variant) {
    const v = {...NOW, ...variant, plus: {...NOW.plus, ...variant.plus}};
    return evalJs(`(() => {
        const {Clutter, St, Gio, GLib} = imports.gi;
        const v = ${JSON.stringify(v)};
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'bwm-variant.css']);
        const file = Gio.File.new_for_path(path);
        if (global._bwmVariantCss)
            theme.unload_stylesheet(global._bwmVariantCss);
        GLib.file_set_contents(path, v.css);
        theme.load_stylesheet(file);
        global._bwmVariantCss = file;

        const put = (b, active) => {
            for (const name of ['variant-grey', 'variant-contrast'])
                b.row.remove_effect_by_name(name);
            if (!active && v.grey > 0)
                b.row.add_effect_with_name('variant-grey', new Clutter.DesaturateEffect({factor: v.grey}));
            if (!active && v.contrast !== 0) {
                const c = new Clutter.BrightnessContrastEffect();
                c.set_contrast(v.contrast);
                b.row.add_effect_with_name('variant-contrast', c);
            }
            b.actor.opacity = active ? 255 : v.opacity;
            for (const icon of b.row.get_children().filter(a => a.has_style_class_name?.('bwm-app-icon')))
                icon.icon_size = active ? 22 : v.small;
            if (b.plusIcon) {
                b.plusIcon.icon_size = v.plus.size;
                b.plusIcon.width = v.plus.slot;
                if (v.hover) b.actor.add_style_pseudo_class('hover');
                else b.actor.remove_style_pseudo_class('hover');
            }
        };
        const ext = Main.extensionManager.lookup('borshevik-workspace-manager@komorebinator').stateObj;
        const seen = new Set();
        const find = (o, depth) => {
            if (!o || typeof o !== 'object' || seen.has(o) || depth > 3)
                return null;
            seen.add(o);
            if (o._view && typeof o._view._setActive === 'function')
                return o._view;
            for (const k of Object.keys(o)) {
                const r = find(o[k], depth + 1);
                if (r)
                    return r;
            }
            return null;
        };
        const view = find(ext, 0);
        const proto = Object.getPrototypeOf(view);
        if (!proto._bwmVariantSetActive) {
            proto._bwmVariantSetActive = proto._setActive;
            proto._setActive = function (b, active) {
                this._bwmVariantSetActive(b, active);
                global._bwmVariantPut?.(b, active);
            };
        }
        global._bwmVariantPut = put;
        for (const b of view._buttons.values())
            put(b, b.bg.has_style_class_name('bwm-ws-active'));
        return 'ok';
    })()`);
}

// What the stand photographs: a few apps' windows on the first three workspaces, the second
// active, and the empty last one with its '+'. Set when the machine has no windows, as after
// a deploy, which restarts the session.
const SCENE = [
    ['org.gnome.Nautilus.desktop', 'org.gnome.Ptyxis.desktop'],
    ['org.gnome.Settings.desktop'],
    ['org.gnome.Software.desktop', 'org.gnome.SystemMonitor.desktop'],
];

function setScene() {
    const windows = Number(evalJs('String(global.display.list_all_windows().filter(w => w.window_type === 0).length)'));
    if (windows > 0)
        return;
    SCENE.forEach((apps, i) => {
        evalJs(`(() => {
            const wm = global.workspace_manager;
            while (wm.n_workspaces <= ${i})
                wm.append_new_workspace(false, 0);
            wm.get_workspace_by_index(${i}).activate(global.get_current_time());
            return 'ok';
        })()`);
        sleep(2);
        for (const app of apps) {
            evalJs(`imports.gi.Shell.AppSystem.get_default().lookup_app('${app}').open_new_window(-1)`);
            sleep(4);
        }
    });
    activate();
}

function indicatorBox() {
    return JSON.parse(evalJs(`(() => {
        const walk = a => [a, ...a.get_children().flatMap(walk)];
        const a = walk(Main.panel).find(a => a.has_style_class_name?.('bwm-indicator'));
        const [x, y] = a.get_transformed_position();
        const [width, height] = a.get_transformed_size();
        return JSON.stringify({x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height)});
    })()`));
}

// The workspace a group is photographed on: the last, or the second, as the scene is set.
function activate(which) {
    evalJs(`(() => {
        const wm = global.workspace_manager;
        wm.get_workspace_by_index(${which === 'last' ? 'wm.n_workspaces - 1' : 1}).activate(global.get_current_time());
        return 'ok';
    })()`);
    sleep(1.5);
}

function setCase(name) {
    evalJs(`new (imports.gi.Gio.Settings)({schema_id: 'org.gnome.desktop.interface'}).set_string('color-scheme', '${name === 'light' ? 'default' : 'prefer-dark'}')`);
    sleep(2);
}

function photograph(file) {
    const b = indicatorBox();
    vm('shot', `${outDir}/screen.png`);
    const screen = GdkPixbuf.Pixbuf.new_from_file(`${outDir}/screen.png`);
    const x = Math.max(0, b.x - MARGIN), y = Math.max(0, b.y);
    const width = Math.min(screen.get_width() - x, b.width + 2 * MARGIN);
    const height = Math.min(screen.get_height() - y, b.height);
    screen.new_subpixbuf(x, y, width, height).savev(file, 'png', [], []);
}

// One sheet per group: a row per variant, its label, then light and dark side by side.
function sheet(group) {
    const label = 300;
    const shots = group.variants.map((_, i) => CASES.map(c => {
        const p = GdkPixbuf.Pixbuf.new_from_file(`${outDir}/shots/${group.id}-${i}-${c}.png`);
        return p.scale_simple(p.get_width() * SCALE, p.get_height() * SCALE, GdkPixbuf.InterpType.NEAREST);
    }));
    const cellWidth = Math.max(...shots.flat().map(p => p.get_width()));
    const rowHeight = Math.max(...shots.flat().map(p => p.get_height()));
    const width = label + CASES.length * (cellWidth + 8) + 8;
    const height = shots.length * (rowHeight + 8) + 8;
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, width, height);
    const cr = new Cairo.Context(surface);
    cr.setSourceRGB(0.5, 0.5, 0.5);
    cr.paint();
    const layout = PangoCairo.create_layout(cr);
    layout.set_font_description(Pango.FontDescription.from_string('Sans Bold 11'));
    shots.forEach((row, r) => {
        const y = 8 + r * (rowHeight + 8);
        cr.setSourceRGB(1, 1, 1);
        cr.moveTo(8, y + rowHeight / 2 - 8);
        layout.set_text(group.variants[r].label, -1);
        PangoCairo.show_layout(cr, layout);
        row.forEach((p, i) => {
            Gdk.cairo_set_source_pixbuf(cr, p, label + i * (cellWidth + 8), y);
            cr.paint();
        });
    });
    surface.writeToPNG(`${outDir}/${group.id}.png`);
}

// `show <variant as JSON>`: one variant put on the machine's panel to be looked at there,
// until the next one — `show '{"opacity": 204}'`; `show '{}'` puts back what the extension has
if (System.programArgs[0] === 'show') {
    setScene();
    print(apply(JSON.parse(System.programArgs[1] ?? '{}')));
    System.exit(0);
}

const filter = System.programArgs[0] ?? '';
const groups = GROUPS.filter(g => g.id.includes(filter));
setScene();
try {
    for (const c of CASES) {
        setCase(c);
        for (const group of groups) {
            activate(group.activate);
            group.variants.forEach((v, i) => {
                apply(v);
                sleep(1);
                photograph(`${outDir}/shots/${group.id}-${i}-${c}.png`);
                print(`${c} ${group.id} ${v.label}`);
            });
        }
    }
} finally {
    apply({});
    activate();
}
for (const group of groups) {
    sheet(group);
    print(`sheet: ${outDir}/${group.id}.png`);
}
