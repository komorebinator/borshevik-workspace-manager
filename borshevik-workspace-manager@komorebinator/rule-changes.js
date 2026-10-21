/* rule-changes.js — a saved list of window rules brought up to date with the default rules.
 *
 * A default rule reaches by itself only an account that never saved rules: saving writes the
 * whole list, the defaults of that day among them, and the schema is never read again. What
 * changed in the defaults is kept as versions, rule-changes/<n>.json, and the account keeps in
 * rules-version the last one it has. Every change leaves alone what the user made their own.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from 'gi://Gio';
import { LOG } from './log.js';

const decoder = new TextDecoder();
const copy = v => JSON.parse(JSON.stringify(v));

// the value at a dotted path into a rule, undefined where the rule has none
const at = (rule, path) => path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), rule);

function put(rule, path, value) {
    const keys = path.split('.');
    let o = rule;
    for (const k of keys.slice(0, -1)) {
        if (!o[k] || typeof o[k] !== 'object') o[k] = {};
        o = o[k];
    }
    o[keys.at(-1)] = value;
}

// equal as JSON values, whatever the order of their keys
function same(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
}

// a field's `from` of null stands for a field the rule does not have
const holds = (rule, path, value) => (value === null ? at(rule, path) === undefined : same(at(rule, path), value));

// One version's changes applied to a list of rules; the new list, or null when nothing changed.
// defaults: the schema's default rules, where an added rule is taken from.
export function applyChanges(rules, changes, defaults) {
    let list = rules.map(r => copy(r));
    let changed = false;
    const find = id => list.find(r => r.id === id);
    for (const c of changes) {
        if ('add' in c) {
            if (find(c.add)) continue;
            // the file and the schema ship together: a rule gone from the schema was taken out of it
            const rule = defaults.find(r => r.id === c.add);
            if (!rule) continue;
            list.push(copy(rule));
            changed = true;
        } else if ('set' in c) {
            const rule = find(c.set);
            if (!rule) continue;
            const fields = Object.entries(c.fields);
            if (!fields.every(([path, f]) => holds(rule, path, f.from))) continue;
            for (const [path, f] of fields) put(rule, path, copy(f.to));
            changed = true;
        } else if ('remove' in c) {
            const rule = find(c.remove);
            if (!rule || !c.was.some(w => same(rule, w))) continue;
            list = list.filter(r => r !== rule);
            changed = true;
        } else {
            throw new Error(`unknown change ${JSON.stringify(c)}`);
        }
    }
    return changed ? list : null;
}

function newest(dir) {
    let n = 0;
    const children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info; (info = children.next_file(null));) {
        const m = /^(\d+)\.json$/.exec(info.get_name());
        if (m) n = Math.max(n, Number(m[1]));
    }
    children.close(null);
    return n;
}

// At enable, before anything reads the rules. dir: the extension's rule-changes directory.
export function catchUp(settings, dir) {
    const file = n => dir.get_child(`${n}.json`);
    let version = settings.get_int('rules-version');
    if (!file(version + 1).query_exists(null)) return;
    // never saved: the rules are the schema's, already current; recorded at once, so a default
    // deleted after a later save is not added back
    if (settings.get_user_value('window-rules') === null) {
        settings.set_int('rules-version', newest(dir));
        return;
    }
    let rules;
    try {
        rules = JSON.parse(settings.get_string('window-rules'));
    } catch {}
    // read as no rules, and left as it is until the user saves a list that parses
    if (!Array.isArray(rules)) return;
    const defaults = JSON.parse(settings.get_default_value('window-rules').deepUnpack());
    try {
        for (let n = version + 1; file(n).query_exists(null); n++) {
            const [, bytes] = file(n).load_contents(null);
            const next = applyChanges(rules, JSON.parse(decoder.decode(bytes)), defaults);
            if (next) {
                rules = next;
                settings.set_string('window-rules', JSON.stringify(rules));
            }
            settings.set_int('rules-version', n);
            version = n;
            LOG('rule-changes: version', n, next ? 'applied' : 'had nothing to change');
        }
    } catch (e) {
        console.warn(`[BWM] rule-changes: stopped after version ${version}: ${e.message}`);
    }
}
