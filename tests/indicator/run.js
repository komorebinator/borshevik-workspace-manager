// Tests of indicator-model.js#diff on plain objects: what the panel indicator's view is told to
// change, from one model to the next. No shell needed; run on the host:
//
//   gjs -m tests/indicator/run.js
import System from 'system';
import { diff } from '../../borshevik-workspace-manager@komorebinator/indicator-model.js';

// a workspace is any object: diff tells entries apart by it, never by number
const S = { name: 'S' }, T = { name: 'T' }, U = { name: 'U' }, V = { name: 'V' };
const icon = id => ({ id, app: null });
const e = (ws, num, { active = false, plus = false, icons = [] } = {}) => ({ ws, num, active, plus, icons: icons.map(icon) });
const show = cs => cs.map(c => `${c.type} ${c.entry.ws.name}${c.at !== undefined ? `@${c.at}` : ''}` +
    `${c.from !== undefined ? ` ${c.from}→${c.to}` : ''}`).join(', ') || 'nothing';

const cases = [
    {
        name: 'the same wall changes nothing',
        prev: [e(S, 1, { active: true, icons: ['a'] }), e(T, 2, { plus: true })],
        next: [e(S, 1, { active: true, icons: ['a'] }), e(T, 2, { plus: true })],
        expect: 'nothing',
    },
    {
        name: 'switching workspace changes two buttons\' state, nothing else',
        prev: [e(S, 1, { active: true, icons: ['a'] }), e(T, 2, { icons: ['b'] }), e(U, 3, { plus: true })],
        next: [e(S, 1, { icons: ['a'] }), e(T, 2, { active: true, icons: ['b'] }), e(U, 3, { plus: true })],
        expect: 'active S, active T',
    },
    {
        name: 'a window opened changes its own workspace\'s icons',
        prev: [e(S, 1, { active: true, icons: ['a'] }), e(T, 2, { plus: true })],
        next: [e(S, 1, { active: true, icons: ['a', 'b'] }), e(T, 2, { plus: true })],
        expect: 'icons S',
    },
    {
        name: 'a window on the \'+\' turns it into a workspace, and a new \'+\' is added',
        prev: [e(S, 1, { icons: ['a'] }), e(T, 2, { active: true, plus: true })],
        next: [e(S, 1, { icons: ['a'] }), e(T, 2, { active: true, icons: ['b'] }), e(U, 3, { plus: true })],
        expect: 'added U@2, icons T',
    },
    {
        name: 'a workspace emptied and gone takes its button; the ones after it are renumbered',
        prev: [e(S, 1, { icons: ['a'] }), e(T, 2, { active: true, icons: ['b'] }), e(U, 3, { icons: ['c'] }), e(V, 4, { plus: true })],
        next: [e(S, 1, { active: true, icons: ['a'] }), e(U, 2, { icons: ['c'] }), e(V, 3, { plus: true })],
        expect: 'removed T, active S, num U, num V',
    },
    {
        name: 'a workspace dragged to the end moves, and only it',
        prev: [e(S, 1, { active: true, icons: ['a'] }), e(T, 2, { icons: ['b'] }), e(U, 3, { icons: ['c'] }), e(V, 4, { plus: true })],
        next: [e(T, 1, { icons: ['b'] }), e(U, 2, { icons: ['c'] }), e(S, 3, { active: true, icons: ['a'] }), e(V, 4, { plus: true })],
        expect: 'moved S 0→2, num T, num U, num S',
    },
    {
        name: 'icons in a new order are a change of icons',
        prev: [e(S, 1, { active: true, icons: ['a', 'b'] })],
        next: [e(S, 1, { active: true, icons: ['b', 'a'] })],
        expect: 'icons S',
    },
    {
        name: 'the last workspace dragged first moves, and only it',
        prev: [e(S, 1, { icons: ['a'] }), e(T, 2, { icons: ['b'] }), e(U, 3, { active: true, icons: ['c'] })],
        next: [e(U, 1, { active: true, icons: ['c'] }), e(S, 2, { icons: ['a'] }), e(T, 3, { icons: ['b'] })],
        expect: 'moved U 2→0, num U, num S, num T',
    },
];

let failed = 0;
for (const c of cases) {
    const got = show(diff(c.prev, c.next));
    if (got === c.expect) {
        print(`ok   ${c.name}`);
    } else {
        failed++;
        print(`FAIL ${c.name}\n      expected ${c.expect}\n      found    ${got}`);
    }
}
print(`\n${cases.length - failed} ok, ${failed} failed`);
System.exit(failed ? 1 : 0);
