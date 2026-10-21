// Tests of rule-changes.js#applyChanges on plain objects, and of the shipped version files: how
// a saved list of window rules is brought up to date with the defaults. No shell needed; run on
// the host:
//
//   gjs -m tests/rule-changes/run.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';
import { applyChanges } from '../../borshevik-workspace-manager@komorebinator/rule-changes.js';

const EXT = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_parent()
    .get_child('borshevik-workspace-manager@komorebinator').get_path();

// a rule as rules-ui writes it, reduced to what the cases need
const rule = (id, cls, extra = {}) => ({
    id,
    conditions: { class: { enabled: true, regex: cls }, title: { enabled: false, regex: '' } },
    actions: { above: { enabled: false, value: true }, close: { enabled: false, value: true } },
    ...extra,
});
const ids = list => (list ? list.map(r => r.id).join(',') : 'null');

const A = rule('a', 'steam'), B = rule('b', 'pip'), NEW = rule('new', 'discover'), MINE = rule('mine', 'mine');
const defaults = [A, B, NEW];

const cases = [
    {
        name: 'an added rule is appended after the saved ones',
        run: () => ids(applyChanges([A, MINE], [{ add: 'new' }], defaults)),
        expect: 'a,mine,new',
    },
    {
        name: 'an added rule the list already has changes nothing',
        run: () => ids(applyChanges([A, NEW], [{ add: 'new' }], defaults)),
        expect: 'null',
    },
    {
        name: 'a rule no longer among the defaults is not added',
        run: () => ids(applyChanges([A], [{ add: 'gone' }], defaults)),
        expect: 'null',
    },
    {
        name: 'set changes every field of the change while all hold their from',
        run: () => {
            const next = applyChanges([A], [{ set: 'a', fields: {
                'conditions.class.regex': { from: 'steam', to: '^steam$' },
                'actions.above.enabled': { from: false, to: true },
            } }], defaults);
            return next ? `${next[0].conditions.class.regex} ${next[0].actions.above.enabled}` : 'null';
        },
        expect: '^steam$ true',
    },
    {
        name: 'set leaves the whole rule when the user changed one of its fields',
        run: () => {
            const changed = rule('a', 'steam-mine');
            return ids(applyChanges([changed], [{ set: 'a', fields: {
                'conditions.class.regex': { from: 'steam', to: '^steam$' },
                'actions.above.enabled': { from: false, to: true },
            } }], defaults));
        },
        expect: 'null',
    },
    {
        name: 'set takes a field the rule lacks by a from of null',
        run: () => {
            const old = rule('a', 'steam');
            delete old.actions.close;
            const next = applyChanges([old], [{ set: 'a', fields: { 'actions.close': { from: null, to: { enabled: true, value: true } } } }], defaults);
            return next ? JSON.stringify(next[0].actions.close) : 'null';
        },
        expect: '{"enabled":true,"value":true}',
    },
    {
        name: 'set on a rule the user deleted brings nothing back',
        run: () => ids(applyChanges([B], [{ set: 'a', fields: { 'conditions.class.regex': { from: 'steam', to: 'x' } } }], defaults)),
        expect: 'null',
    },
    {
        name: 'remove takes out a rule as it was shipped, whatever the order of its keys',
        run: () => {
            const reordered = { actions: A.actions, id: 'a', conditions: A.conditions };
            return ids(applyChanges([reordered, B], [{ remove: 'a', was: [A] }], defaults));
        },
        expect: 'b',
    },
    {
        name: 'remove takes out a rule saved in an older shipped version',
        run: () => {
            const older = rule('a', 'steam');
            delete older.actions.close;
            return ids(applyChanges([older, B], [{ remove: 'a', was: [A, older] }], defaults));
        },
        expect: 'b',
    },
    {
        name: 'remove leaves a rule the user changed',
        run: () => ids(applyChanges([rule('a', 'steam-mine'), B], [{ remove: 'a', was: [A] }], defaults)),
        expect: 'null',
    },
    {
        name: 'the list given is not changed in place',
        run: () => {
            const saved = [A];
            applyChanges(saved, [{ add: 'new' }, { set: 'a', fields: { 'conditions.class.regex': { from: 'steam', to: 'x' } } }], defaults);
            return `${saved.length} ${A.conditions.class.regex}`;
        },
        expect: '1 steam',
    },
    {
        name: 'a change of an unknown kind is refused',
        run: () => {
            try {
                applyChanges([A], [{ rename: 'a' }], defaults);
                return 'taken';
            } catch {
                return 'refused';
            }
        },
        expect: 'refused',
    },
];

// the shipped files: numbered from 1 with no gap, each a list of known changes whose added ids
// are among the schema's defaults
function shippedFiles() {
    const xml = new TextDecoder().decode(GLib.file_get_contents(
        `${EXT}/schemas/org.gnome.shell.extensions.borshevik-workspace-manager.gschema.xml`)[1]);
    const literal = /<key name="window-rules" type="s">\s*<default>([\s\S]*?)<\/default>/.exec(xml)[1];
    const schemaIds = new Set(JSON.parse(GLib.Variant.parse(null, literal, null, null).deepUnpack()).map(r => r.id));
    const dir = Gio.File.new_for_path(`${EXT}/rule-changes`);
    const names = [];
    const children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info; (info = children.next_file(null));) names.push(info.get_name());
    const numbers = names.map(n => /^(\d+)\.json$/.exec(n)?.[1]).map(Number).sort((a, b) => a - b);
    if (numbers.some(Number.isNaN)) return `not a version file: ${names.join(', ')}`;
    if (numbers.some((n, i) => n !== i + 1)) return `versions ${numbers.join(', ')} are not 1 to ${numbers.length}`;
    for (const n of numbers) {
        const changes = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${EXT}/rule-changes/${n}.json`)[1]));
        if (!Array.isArray(changes)) return `${n}.json is not a list`;
        for (const c of changes) {
            if (!['add', 'set', 'remove'].some(k => k in c)) return `${n}.json has a change of an unknown kind`;
            if ('add' in c && !schemaIds.has(c.add)) return `${n}.json adds ${c.add}, which the schema's defaults do not have`;
        }
    }
    return `${numbers.length} version(s) fine`;
}
cases.push({ name: 'the shipped version files', run: shippedFiles, expect: null });

let ok = 0, failed = 0;
for (const c of cases) {
    let got;
    try {
        got = c.run();
    } catch (e) {
        got = `threw: ${e.message}`;
    }
    const pass = c.expect === null ? /version\(s\) fine$/.test(got) : got === c.expect;
    if (pass) {
        ok++;
        print(`ok   ${c.name}${c.expect === null ? ` (${got})` : ''}`);
    } else {
        failed++;
        print(`FAIL ${c.name}: got ${got}${c.expect === null ? '' : `, expected ${c.expect}`}`);
    }
}
print(`${ok} ok, ${failed} failed`);
System.exit(failed ? 1 : 0);
