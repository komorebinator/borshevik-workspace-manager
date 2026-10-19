// The scenarios of @BorshevikWorkspaceManagerExtension#behaviour as data, one entry per scenario,
// keyed by its path. Acted out against a real GNOME Shell by tests/vm/run.js, and against the
// planner by tests/planner/run.js; both read the same entries, so a scenario is written once.
//
// given.workspaces — the primary monitor's workspaces in order, each { left, right, full, floating }.
//   A window is a name, or { name, width } for a tile (a share of the work area), or
//   { name, size: [w, h], place: [x, y], minWidth, minWidthAfter } for a floating one (shares of the work
//   area), or { name, fullscreen: true } for a full one. Tiles are made with Super+Left/Right
//   from a small floating window, full ones are opened maximized, floating ones opened last.
// given.active — the workspace shown before `steps` (default 0).
// given.steps — actions done after the layout is built, for the history a scenario needs.
// given.settings — extension settings for this scenario; the view-moving ones are off otherwise.
// given.focusMode — GNOME's focus mode, 'sloppy' (Borshevik's default, and so the default here),
//   'click' or 'mouse'.
// when — one action. then — what must be seen afterwards:
//   workspaces, each { left, right, full, tiled: [either side], floating: [...], minimized: [...] },
//   compared exactly, empty workspaces at the end left out; active — the workspace shown;
//   focused — the window with the keyboard focus;
//   check(h) — anything else, returning an error string or null.
//
// Actions: ['open', name, { size, maximized, fullscreen, minWidth }], ['tile', name, side],
// ['maximize' | 'unmaximize' | 'fullscreen' | 'unfullscreen' | 'minimize' | 'restore' | 'close'
// | 'click', name], ['moveTo', name, index], ['activate', index], ['place', name, [x, y]],
// ['drag', name, 'left' | 'right' | 'top' | [x, y]], ['dragAway', name], ['clickTitle', name],
// ['pointer', null, [x, y]] — the pointer moved there without a button.
// A step may end with { quick: true }: the next one follows as soon as nothing changes for a poll,
// as a person acting at once would, rather than after the shell has been still a while.
//
// skip: { vm, planner } — why a level cannot act it out yet.

const TILE = [0.4, 1.0];

const sameRect = (a, b, tol = 12) =>
    Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;

const sameSize = (a, b, tol = 12) =>
    Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;

export const helpers = { sameRect, sameSize };

// Scenarios with a group run with a real app, and only when a change touches the group's paths
// (git pathspec globs) — or with --select all. The rest always run.
const EXT = 'borshevik-workspace-manager@komorebinator';
export const groups = {
    chrome: {
        paths: [`${EXT}/executor.js`, `${EXT}/windows.js`, `${EXT}/drag.js`],
        why: "Chrome's own ways: geometry it changes back after an unmaximize, a session restore, a tab dragged out",
    },
    android: {
        paths: [`${EXT}/android.js`],
        why: "Waydroid's windows: needs Android up, and every recreation of a window takes seconds",
    },
};

export const scenarios = [
    // ── role-by-size ───────────────────────────────────────────────────────────
    {
        id: 'role-by-size#opens-nearly-full',
        given: { workspaces: [{ floating: ['X'] }] },
        when: ['open', 'W', { size: [0.95, 0.95] }],
        then: { workspaces: [{ floating: ['X'] }, { full: 'W' }], active: 1 },
    },
    {
        id: 'role-by-size#opens-tile-shaped',
        given: { workspaces: [{ left: 'A' }] },
        when: ['open', 'W', { size: TILE }],
        then: {
            workspaces: [{ left: 'A', right: 'W' }], active: 0,
            check: h => Math.abs(h.rect('A').width + h.rect('W').width - h.wa.width) <= 12
                ? null : 'W does not fill what A leaves',
        },
    },
    {
        id: 'role-by-size#opens-other',
        given: { workspaces: [{}] },
        when: ['open', 'W', { size: [0.3, 0.4] }],
        then: {
            workspaces: [{ floating: ['W'] }], active: 0,
            check: h => sameSize(h.rect('W'), h.share(0.3, 0.4), 24) ? null : 'W did not keep its size',
        },
    },
    {
        id: 'role-by-size#not-judged-again',
        given: { workspaces: [{ left: 'A', right: 'B' }] },
        when: ['open', 'W', { size: TILE }],
        then: { workspaces: [{ left: 'A', right: 'B' }, { tiled: ['W'] }], active: 1 },
    },
    {
        id: 'role-by-size#session-restore',
        given: { workspaces: [{ floating: ['X'] }] },
        when: ['openMany', [['P', { maximized: true }], ['Q', { maximized: true }], ['T', { size: TILE }]]],
        then: {
            check: h => {
                const p = h.win('P'), q = h.win('Q');
                if (!p?.full || !q?.full) return 'P and Q are not both full';
                if (p.ws === q.ws || p.ws === h.win('X').ws || q.ws === h.win('X').ws)
                    return 'P and Q do not each have a workspace of their own';
                if (h.windowsOn(p.ws).length !== 1 || h.windowsOn(q.ws).length !== 1)
                    return 'P or Q shares its workspace';
                const t = h.win('T');
                return t.role === 'left' || t.role === 'right' ? null : 'T was not tiled';
            },
        },
    },

    // ── full-alone ─────────────────────────────────────────────────────────────
    {
        id: 'full-alone#maximize-shared',
        given: { workspaces: [{ floating: ['W', 'X'] }] },
        when: ['maximize', 'W'],
        then: { workspaces: [{ floating: ['X'] }, { full: 'W' }], active: 1, focused: 'W' },
    },
    {
        id: 'full-alone#maximize-alone',
        given: { workspaces: [{ floating: ['W'] }] },
        when: ['maximize', 'W'],
        then: { workspaces: [{ full: 'W' }], active: 0 },
    },
    {
        id: 'full-alone#drop-at-top',
        given: { workspaces: [{ floating: ['W', 'X'] }] },
        when: ['drag', 'W', 'top'],
        then: { workspaces: [{ floating: ['X'] }, { full: 'W' }], active: 1 },
    },
    {
        id: 'full-alone#tile-goes-fullscreen',
        given: { workspaces: [{ left: 'W', right: 'B' }] },
        when: ['fullscreen', 'W'],
        then: { workspaces: [{ right: 'B' }, { full: 'W' }], active: 1 },
    },
    {
        id: 'full-alone#opens-maximized-shared',
        given: { workspaces: [{ floating: ['X'] }] },
        when: ['open', 'W', { maximized: true }],
        then: { workspaces: [{ floating: ['X'] }, { full: 'W' }], active: 1 },
    },

    // ── two-slots ──────────────────────────────────────────────────────────────
    {
        id: 'two-slots#free-slot',
        given: { workspaces: [{ left: { name: 'A', width: 0.6 }, floating: ['W'] }] },
        when: ['tile', 'W', 'right'],
        then: {
            workspaces: [{ left: 'A', right: 'W' }], active: 0,
            check: h => h.unchanged('A') ?? (Math.abs(h.rect('W').width - h.wa.width * 0.4) <= 12
                ? null : 'W does not take what A leaves'),
        },
    },
    {
        id: 'two-slots#narrow-remainder',
        given: { workspaces: [{ left: { name: 'A', width: 0.85 }, floating: [{ name: 'W', minWidth: 0.3 }] }] },
        when: ['tile', 'W', 'right'],
        then: {
            workspaces: [{ left: 'A', right: 'W' }], active: 0,
            check: h => {
                const a = h.rect('A'), w = h.rect('W');
                if (w.width < h.wa.width * 0.3 - 12) return 'W is narrower than it can be';
                if (a.x + a.width > w.x + 12) return 'A and W overlap';
                return Math.abs(a.width + w.width - h.wa.width) <= 12 ? null : 'A and W do not fill the work area';
            },
        },
    },
    {
        // a slow app: it reaches its smallest width a second after it is made narrower
        id: 'two-slots#narrow-remainder-slow',
        given: { workspaces: [{ left: { name: 'A', width: 0.85 }, floating: [{ name: 'W', minWidth: 0.3, minWidthAfter: 1 }] }] },
        when: ['tile', 'W', 'right'],
        then: {
            workspaces: [{ left: 'A', right: 'W' }], active: 0,
            check: h => {
                const a = h.rect('A'), w = h.rect('W');
                if (w.width < h.wa.width * 0.3 - 12) return 'W is narrower than it can be';
                if (a.x + a.width > w.x + 12) return 'A and W overlap';
                return Math.abs(a.width + w.width - h.wa.width) <= 12 ? null : 'A and W do not fill the work area';
            },
        },
    },
    {
        id: 'two-slots#taken-other-free',
        given: { workspaces: [{ left: { name: 'A', width: 0.6 }, floating: ['W'] }] },
        when: ['tile', 'W', 'left'],
        then: {
            workspaces: [{ left: 'W', right: 'A' }], active: 0,
            check: h => sameSize(h.rect('A'), h.before.rect('A')) ? null : 'A did not keep its width',
        },
    },
    {
        id: 'two-slots#both-taken-explicit',
        given: { workspaces: [{ left: 'A', right: 'B', floating: ['W'] }] },
        when: ['tile', 'W', 'left'],
        then: { workspaces: [{ tiled: ['A'] }, { left: 'W', right: 'B' }], active: 1 },
    },
    {
        id: 'two-slots#both-taken-new-window',
        given: { workspaces: [{ left: 'A', right: 'B' }] },
        when: ['open', 'W', { size: TILE }],
        then: { workspaces: [{ left: 'A', right: 'B' }, { tiled: ['W'] }], active: 1 },
    },
    {
        id: 'two-slots#tile-on-full',
        given: { workspaces: [{ full: 'M', floating: ['W'] }] },
        when: ['tile', 'W', 'left'],
        then: { workspaces: [{ full: 'M' }, { left: 'W' }], active: 1 },
    },
    {
        id: 'two-slots#untile-same-side',
        given: { workspaces: [{ left: 'W' }] },
        when: ['tile', 'W', 'left'],
        then: {
            workspaces: [{ floating: ['W'] }], active: 0,
            check: h => sameSize(h.rect('W'), h.share(0.3, 0.3), 24) ? null : 'W did not float at its remembered size',
        },
    },
    {
        id: 'two-slots#linked-resize',
        given: { workspaces: [{ left: 'A', right: 'B' }] },
        when: ['resizeEdge', 'A', 0.6],
        then: {
            workspaces: [{ left: 'A', right: 'B' }], active: 0,
            check: h => Math.abs(h.rect('A').width - 0.6 * h.wa.width) > 12 ? 'A was not resized'
                : Math.abs(h.rect('A').width + h.rect('B').width - h.wa.width) <= 12
                && h.rect('A').x + h.rect('A').width <= h.rect('B').x + 12 ? null : 'B does not fill what A leaves',
        },
    },
    {
        id: 'two-slots#float-size-remembered',
        given: { workspaces: [{ floating: [{ name: 'W', size: [0.35, 0.45] }] }], steps: [['tile', 'W', 'left']] },
        when: ['tile', 'W', 'left'],
        then: {
            workspaces: [{ floating: ['W'] }], active: 0,
            check: h => sameSize(h.rect('W'), h.share(0.35, 0.45), 24) ? null : 'W did not float at the size it had',
        },
    },

    // ── neighbours-only ────────────────────────────────────────────────────────
    {
        id: 'neighbours-only#joins-sibling-left',
        given: {
            workspaces: [{ left: 'C', right: 'B', floating: ['W', 'X'] }],
            steps: [['tile', 'W', 'left']],
        },
        when: ['tile', 'X', 'right'],
        then: { workspaces: [{ left: 'C', right: 'B' }, { left: 'W', right: 'X' }], active: 1 },
    },
    {
        // W, displaced from the left slot, lands in the right one beside C: its width is what C
        // leaves, not what W itself had (planner#tiles leaves the moving window out)
        id: 'neighbours-only#joins-sibling-other-side',
        given: {
            workspaces: [{ left: { name: 'C', width: 0.3 }, right: { name: 'B', width: 0.6 }, floating: ['W', 'X'] }],
            steps: [['tile', 'W', 'left']],
        },
        when: ['tile', 'X', 'left'],
        then: {
            workspaces: [{ left: 'C', right: 'W' }, { left: 'X', right: 'B' }], active: 1,
            check: h => Math.abs(h.rect('W').width + h.rect('C').width - h.wa.width) <= 12 ? null
                : `W (${h.rect('W').width}) and C (${h.rect('C').width}) do not fill the work area`,
        },
    },
    {
        // and back home to the left slot beside B: its width is what B leaves
        id: 'displacement#returns-to-other-side',
        given: {
            workspaces: [{ left: { name: 'C', width: 0.3 }, right: { name: 'B', width: 0.6 }, floating: ['W', 'X'] }],
            steps: [['tile', 'W', 'left'], ['tile', 'X', 'left']],
        },
        when: ['close', 'X'],
        then: {
            workspaces: [{ left: 'C' }, { left: 'W', right: 'B' }],
            check: h => Math.abs(h.rect('W').width + h.rect('B').width - h.wa.width) <= 12 ? null
                : `W (${h.rect('W').width}) and B (${h.rect('B').width}) do not fill the work area`,
        },
    },
    {
        id: 'neighbours-only#new-left',
        given: { workspaces: [{ left: 'U' }, { left: 'A', right: 'B', floating: ['W'] }], active: 1 },
        when: ['tile', 'W', 'left'],
        then: { workspaces: [{ left: 'U' }, { tiled: ['A'] }, { left: 'W', right: 'B' }], active: 2 },
    },
    {
        id: 'neighbours-only#joins-sibling-right',
        given: {
            workspaces: [{ left: 'A', right: 'B' }],
            steps: [['open', 'D', { size: TILE }], ['activate', 0]],
        },
        when: ['open', 'E', { size: TILE }],
        then: { workspaces: [{ left: 'A', right: 'B' }, { tiled: ['D', 'E'] }], active: 1 },
    },
    {
        id: 'neighbours-only#new-right',
        given: { workspaces: [{ left: 'A', right: 'B' }, { left: 'U' }] },
        when: ['open', 'W', { size: TILE }],
        then: { workspaces: [{ left: 'A', right: 'B' }, { tiled: ['W'] }, { left: 'U' }], active: 1 },
    },
    {
        id: 'neighbours-only#would-cover-guest',
        given: {
            workspaces: [{ left: 'C', right: 'B', floating: ['W', 'X'] }],
            steps: [['tile', 'W', 'left'], ['activate', 0], ['open', 'G', { size: [0.25, 0.3] }],
                    ['place', 'G', [0.65, 0.3]], ['activate', 1], ['click', 'X']],
        },
        when: ['tile', 'X', 'right'],
        then: { workspaces: [{ left: 'C', floating: ['G'] }, { tiled: ['B'] }, { left: 'W', right: 'X' }], active: 2 },
    },
    {
        id: 'neighbours-only#no-chain',
        given: { workspaces: [{ left: 'A', right: 'B' }, { left: 'C', right: 'D', floating: ['W'] }], active: 1 },
        when: ['tile', 'W', 'left'],
        then: { workspaces: [{ left: 'A', right: 'B' }, { tiled: ['C'] }, { left: 'W', right: 'D' }], active: 2 },
    },

    // ── displacement ───────────────────────────────────────────────────────────
    {
        id: 'displacement#displaced-left',
        given: { workspaces: [{ left: 'A', right: 'B', floating: ['W'] }] },
        when: ['tile', 'W', 'left'],
        then: { workspaces: [{ tiled: ['A'] }, { left: 'W', right: 'B' }], active: 1 },
    },
    {
        id: 'displacement#returns-when-free',
        given: { workspaces: [{ left: 'A', right: 'B', floating: ['W'] }], steps: [['tile', 'W', 'left']] },
        when: ['close', 'W'],
        then: { workspaces: [{ left: 'A', right: 'B' }], active: 0 },
    },
    {
        id: 'displacement#last-first',
        given: {
            workspaces: [{ left: 'A', right: 'B', floating: ['W', 'X'] }],
            steps: [['tile', 'W', 'left'], ['click', 'X'], ['tile', 'X', 'left']],
        },
        when: ['close', 'X'],
        then: { workspaces: [{ tiled: ['A'] }, { left: 'W', right: 'B' }], active: 1 },
    },
    {
        id: 'displacement#pair-returns',
        skip: { vm: 'both slots of S cannot be freed by one action', planner: 'needs homes set up directly' },
        given: { workspaces: [{ left: 'A', right: 'B' }] },
        when: ['close', 'W'],
        then: { workspaces: [{ left: 'A', right: 'B' }] },
    },
    {
        id: 'displacement#not-torn-apart',
        given: {
            workspaces: [{ left: 'A', right: 'B', floating: ['W'] }],
            steps: [['tile', 'W', 'left'], ['activate', 0], ['open', 'C'], ['tile', 'C', 'right'], ['activate', 1]],
        },
        when: ['close', 'W'],
        then: { workspaces: [{ left: 'A', right: 'C' }, { right: 'B' }], active: 1 },
    },
    {
        id: 'displacement#returns-under-guests',
        given: {
            workspaces: [{ left: 'A', right: 'B', floating: ['W'] }],
            steps: [['tile', 'W', 'left'], ['open', 'G', { size: [0.25, 0.3] }]],
        },
        when: ['close', 'W'],
        then: {
            workspaces: [{ left: 'A', right: 'B', floating: ['G'] }], active: 0,
            check: h => h.win('G').z > h.win('A').z ? null : 'A came back above the guest',
        },
    },
    {
        id: 'displacement#drag-forgets',
        given: {
            workspaces: [{ left: 'A', right: 'B', floating: ['W'] }],
            steps: [['tile', 'W', 'left'], ['activate', 0], ['dragAway', 'A'], ['activate', 1]],
        },
        when: ['close', 'W'],
        then: { workspaces: [{ floating: ['A'] }, { right: 'B' }], active: 1 },
    },
    {
        id: 'displacement#user-move-forgets',
        given: {
            workspaces: [{ left: 'A', right: 'B', floating: ['W'] }],
            steps: [['tile', 'W', 'left'], ['moveTo', 'A', 'last']],
        },
        when: ['close', 'W'],
        then: { workspaces: [{ right: 'B' }, { left: 'A' }], active: 1 },
    },

    // ── covered-guests ─────────────────────────────────────────────────────────
    {
        id: 'covered-guests#into-free-half',
        given: {
            workspaces: [{ floating: [{ name: 'F', size: [0.3, 0.4], place: [0.1, 0.2] },
                                      { name: 'G', size: [0.3, 0.3], place: [0.35, 0.5] }, 'W'] }],
        },
        when: ['tile', 'W', 'left'],
        then: {
            workspaces: [{ left: 'W', floating: ['F', 'G'] }], active: 0,
            check: h => {
                const f = h.rect('F');
                if (f.x < h.wa.x + h.wa.width / 2 - 12) return 'F was not moved into the free half';
                if (!sameSize(f, h.before.rect('F'))) return 'F was resized';
                return h.unchanged('G');
            },
        },
    },
    {
        id: 'covered-guests#to-floating-left',
        given: {
            workspaces: [{ floating: ['P'] }, { left: 'A', right: 'B', floating: [{ name: 'F', place: [0.1, 0.3] }] }],
            active: 1,
        },
        when: ['click', 'A'],
        then: { workspaces: [{ floating: ['P', 'F'] }, { left: 'A', right: 'B' }], active: 1 },
    },
    {
        id: 'covered-guests#new-floating-left',
        given: {
            workspaces: [{ left: 'U' }, { left: 'A', right: 'B', floating: [{ name: 'F', place: [0.1, 0.3] }] }],
            active: 1,
        },
        when: ['click', 'A'],
        then: { workspaces: [{ left: 'U' }, { floating: ['F'] }, { left: 'A', right: 'B' }], active: 2 },
    },
    {
        id: 'covered-guests#too-wide',
        given: { workspaces: [{ left: { name: 'A', width: 0.7 }, floating: [{ name: 'F', size: [0.5, 0.4], place: [0.1, 0.3] }] }] },
        when: ['click', 'A'],
        then: { workspaces: [{ floating: ['F'] }, { left: 'A' }], active: 1 },
    },
    {
        id: 'covered-guests#together',
        given: {
            workspaces: [{ left: 'A', right: 'B', floating: [{ name: 'F', size: [0.2, 0.3], place: [0.05, 0.1] },
                                                            { name: 'G', size: [0.2, 0.3], place: [0.2, 0.5] }] }],
        },
        when: ['click', 'A'],
        then: { workspaces: [{ floating: ['F', 'G'] }, { left: 'A', right: 'B' }], active: 1 },
    },
    {
        id: 'covered-guests#partly-visible',
        given: { workspaces: [{ left: 'A', floating: [{ name: 'F', size: [0.3, 0.3], place: [0.35, 0.3] }] }] },
        when: ['click', 'A'],
        then: { workspaces: [{ left: 'A', floating: ['F'] }], active: 0, check: h => h.unchanged('F') },
    },
    {
        id: 'covered-guests#floaters-overlap',
        given: {
            workspaces: [{ floating: [{ name: 'G', size: [0.2, 0.2], place: [0.4, 0.4] },
                                      { name: 'F', size: [0.5, 0.5], place: [0.3, 0.3] }] }],
        },
        when: ['click', 'F'],
        then: { workspaces: [{ floating: ['F', 'G'] }], active: 0, check: h => h.unchanged('G') },
    },
    {
        id: 'covered-guests#dialog-stays',
        skip: { vm: 'the test window opens no dialogs yet', planner: 'dialogs are not in the snapshot' },
        given: { workspaces: [{}] },
        when: ['click', 'A'],
        then: {},
    },
    {
        id: 'covered-guests#no-return',
        given: {
            workspaces: [{ floating: ['P'] }, { left: 'A', right: 'B', floating: [{ name: 'F', place: [0.1, 0.3] }] }],
            active: 1, steps: [['click', 'A']],
        },
        when: ['close', 'A'],
        then: { workspaces: [{ floating: ['P', 'F'] }, { right: 'B' }], active: 1 },
    },

    // ── view-follows-user ──────────────────────────────────────────────────────
    {
        id: 'view-follows-user#goes-with-user',
        given: { workspaces: [{ floating: ['W', 'X'] }] },
        when: ['maximize', 'W'],
        then: { workspaces: [{ floating: ['X'] }, { full: 'W' }], active: 1 },
    },
    {
        id: 'view-follows-user#stays-for-others',
        given: { workspaces: [{ left: 'A', right: 'B', floating: ['W'] }] },
        when: ['tile', 'W', 'left'],
        then: { workspaces: [{ tiled: ['A'] }, { left: 'W', right: 'B' }], active: 1 },
    },
    {
        id: 'view-follows-user#stays-for-return',
        given: {
            workspaces: [{ left: 'A', right: 'B', floating: ['W'] }],
            steps: [['tile', 'W', 'left'], ['activate', 'last'], ['open', 'Y']],
        },
        when: ['close', 'W'],
        then: { workspaces: [{ left: 'A', right: 'B' }, { floating: ['Y'] }], active: 1 },
    },
    {
        id: 'view-follows-user#opened-elsewhere',
        skip: { vm: 'a window cannot be made to open on an inactive workspace on purpose' },
        given: { workspaces: [{}] },
        when: ['open', 'W'],
        then: {},
    },
    {
        id: 'view-follows-user#once-per-action',
        skip: { vm: 'checked by the view of every other scenario', planner: 'checked by the view of every other scenario' },
        given: { workspaces: [{}] },
        when: ['open', 'W'],
        then: {},
    },
    {
        id: 'view-follows-user#fullscreen-stays',
        given: { workspaces: [{ full: { name: 'G', fullscreen: true } }] },
        when: ['open', 'W', { maximized: true }],
        then: { workspaces: [{ full: 'G' }, { full: 'W' }], active: 0 },
    },
    {
        // the user switches to it themselves at once, by a swipe: the view stays where they took it
        // (2026-10-18: a hold that took the view back for 1.5 s left GNOME half on each workspace)
        id: 'view-follows-user#user-switches-at-once',
        given: {
            workspaces: [{ full: { name: 'G', fullscreen: true } }],
            steps: [['open', 'W', { maximized: true }, { quick: true }]],
        },
        when: ['activate', 1],
        then: { workspaces: [{ full: 'G' }, { full: 'W' }], active: 1 },
    },

    // ── going-home ─────────────────────────────────────────────────────────────
    {
        id: 'going-home#unmaximize-to-free-slot',
        given: { workspaces: [{ left: 'W', right: 'B' }], steps: [['maximize', 'W']] },
        when: ['unmaximize', 'W'],
        then: { workspaces: [{ left: 'W', right: 'B' }], active: 0 },
    },
    {
        id: 'going-home#unmaximize-slot-taken',
        given: {
            workspaces: [{ left: 'W', right: 'B', floating: ['X'] }],
            steps: [['maximize', 'W'], ['activate', 0], ['click', 'X'], ['tile', 'X', 'left'], ['activate', 1]],
        },
        when: ['unmaximize', 'W'],
        then: { workspaces: [{ left: 'X', right: 'B' }, { left: 'W' }], active: 1 },
    },
    {
        id: 'going-home#home-reordered',
        given: {
            workspaces: [{ floating: ['X'] }, { left: 'W', right: 'B' }], active: 1,
            steps: [['maximize', 'W'], ['reorder', 'ws-of:W', 0]],
        },
        when: ['unmaximize', 'W'],
        then: { workspaces: [{ floating: ['X'] }, { left: 'W', right: 'B' }], active: 1 },
    },
    {
        id: 'going-home#unmaximize-was-floating',
        given: { workspaces: [{ floating: ['W', 'X'] }], steps: [['maximize', 'W']] },
        when: ['unmaximize', 'W'],
        then: {
            workspaces: [{ floating: ['W', 'X'] }], active: 0, focused: 'W',
            check: h => h.unchangedSinceGiven('W') ?? (h.win('W').z > h.win('X').z ? null : 'W is not on top'),
        },
    },
    {
        id: 'going-home#untile-alone',
        given: {
            workspaces: [{ left: 'A', right: 'B', floating: ['W'] }],
            // A and B last raised: W is below them in the stacking as it comes home
            steps: [['maximize', 'W'], ['tile', 'W', 'left'], ['click', 'A'], ['click', 'B']],
        },
        when: ['tile', 'W', 'left'],
        then: { workspaces: [{ left: 'A', right: 'B', floating: ['W'] }], active: 0, focused: 'W' },
    },
    {
        // home is a full workspace: VS Code over a maximized Chrome in the author's session
        id: 'going-home#untile-alone-over-full',
        given: {
            workspaces: [{ full: 'F', floating: ['W'] }],
            steps: [['maximize', 'W'], ['tile', 'W', 'right']],
        },
        when: ['tile', 'W', 'right'],
        then: { workspaces: [{ full: 'F', floating: ['W'] }], active: 0, focused: 'W' },
    },
    {
        // W goes right as a tile with the view; the pointer is over the empty half there
        id: 'view-follows-user#focus-goes-along-right',
        given: {
            workspaces: [{ full: 'F', floating: ['W'] }],
            focusMode: 'sloppy',
            steps: [['pointer', null, [0.15, 0.5]]],
        },
        when: ['tile', 'W', 'right'],
        then: { workspaces: [{ full: 'F' }, { right: 'W' }], active: 1, focused: 'W' },
    },
    {
        // focus follows the pointer, which is over F, not W, once W is home (the author's setting)
        id: 'view-follows-user#focus-goes-along',
        given: {
            workspaces: [{ full: 'F', floating: ['W'] }],
            focusMode: 'sloppy',
            steps: [['maximize', 'W'], ['tile', 'W', 'right'], ['pointer', null, [0.85, 0.5]]],
        },
        when: ['tile', 'W', 'right'],
        then: { workspaces: [{ full: 'F', floating: ['W'] }], active: 0, focused: 'W' },
    },
    {
        // a guest over a full window goes home over it again: the full window keeps out tiles only
        // (2026-10-18, Nautilus over a maximized Chrome, unmaximized by its button)
        id: 'going-home#unmaximize-was-floating-over-full',
        given: { workspaces: [{ full: 'F', floating: ['W'] }], steps: [['maximize', 'W']] },
        when: ['unmaximize', 'W'],
        then: { workspaces: [{ full: 'F', floating: ['W'] }], active: 0, focused: 'W' },
    },
    {
        id: 'going-home#drag-carries-home',
        given: { workspaces: [{ left: 'A', right: 'B' }], steps: [['open', 'W', { size: TILE }]] },
        when: ['dragAway', 'W'],
        then: { workspaces: [{ left: 'A', right: 'B', floating: ['W'] }], active: 0, focused: 'W' },
    },
    {
        id: 'going-home#drag-among-strangers',
        given: {
            workspaces: [{ left: 'A', right: 'B' }, { floating: ['V'] }],
            steps: [['open', 'W', { size: TILE }], ['moveTo', 'V', 'ws-of:W']],
        },
        when: ['dragAway', 'W'],
        then: { workspaces: [{ left: 'A', right: 'B' }, { tiled: ['V'], floating: ['W'] }], active: 1 },
    },
    {
        id: 'going-home#drag-full',
        given: { workspaces: [{ floating: ['W', 'X'] }], steps: [['maximize', 'W']] },
        when: ['dragAway', 'W'],
        then: { workspaces: [{ floating: ['W', 'X'] }], active: 0 },
    },
    {
        id: 'going-home#home-gone',
        given: { workspaces: [{ floating: ['W', 'X'] }], steps: [['maximize', 'W'], ['close', 'X']] },
        when: ['unmaximize', 'W'],
        then: { workspaces: [{ floating: ['W'] }], active: 0 },
    },

    // ── minimize ───────────────────────────────────────────────────────────────
    {
        id: 'minimize#frees-slot',
        given: { workspaces: [{ left: 'C', right: 'B', floating: ['A'] }], steps: [['tile', 'A', 'left']] },
        when: ['minimize', 'A'],
        then: { workspaces: [{ left: 'C', right: 'B', minimized: ['A'] }], active: 0 },
    },
    {
        id: 'minimize#restore-takes-slot',
        given: {
            workspaces: [{ left: 'A', right: 'B', floating: ['X'] }],
            steps: [['minimize', 'A'], ['click', 'X'], ['tile', 'X', 'left']],
        },
        when: ['restore', 'A'],
        then: { workspaces: [{ tiled: ['X'] }, { left: 'A', right: 'B' }], active: 1 },
    },
    {
        // the restored window registered after the tile that came back to its slot (Nautilus over
        // Chrome in the author's session, 2026-10-18)
        id: 'minimize#restore-displaces-returned',
        given: {
            workspaces: [{ left: 'C', right: 'B', floating: ['N'] }],
            steps: [['drag', 'N', 'left'], ['minimize', 'N']],
        },
        when: ['restore', 'N'],
        then: { workspaces: [{ tiled: ['C'] }, { left: 'N', right: 'B' }], active: 1 },
    },
    {
        id: 'minimize#cycle',
        given: {
            workspaces: [{ left: 'A', right: 'B', floating: ['X'] }],
            steps: [['minimize', 'A'], ['click', 'X'], ['tile', 'X', 'left'], ['restore', 'A']],
        },
        when: ['minimize', 'A'],
        then: { workspaces: [{ left: 'X', right: 'B', minimized: ['A'] }], active: 0 },
    },
    {
        id: 'minimize#restore-from-elsewhere',
        given: {
            workspaces: [{ left: 'A', right: 'B' }, { floating: ['Y'] }],
            steps: [['minimize', 'A'], ['activate', 1]],
        },
        when: ['restore', 'A'],
        then: { workspaces: [{ left: 'A', right: 'B' }, { floating: ['Y'] }], active: 0 },
    },
    {
        id: 'minimize#restore-full',
        given: { workspaces: [{ full: 'A' }], steps: [['minimize', 'A'], ['open', 'Y']] },
        when: ['restore', 'A'],
        then: { workspaces: [{ floating: ['Y'] }, { full: 'A' }], active: 1 },
    },
    {
        id: 'minimize#restore-floating',
        given: { workspaces: [{ left: 'T', floating: [{ name: 'F', place: [0.55, 0.3] }] }], steps: [['minimize', 'F']] },
        when: ['restore', 'F'],
        then: {
            workspaces: [{ left: 'T', floating: ['F'] }], active: 0,
            check: h => h.unchangedSinceGiven('F') ?? (h.win('F').z > h.win('T').z ? null : 'F is not on top'),
        },
    },

    // ── user-moves ─────────────────────────────────────────────────────────────
    {
        id: 'user-moves#tile-to-empty',
        given: { workspaces: [{ left: 'W', right: 'B' }] },
        when: ['moveTo', 'W', 'last'],
        then: { workspaces: [{ right: 'B' }, { left: 'W' }], active: 1 },
    },
    {
        id: 'user-moves#to-one-free-slot',
        given: { workspaces: [{ floating: ['W'] }, { left: 'T' }] },
        when: ['moveTo', 'W', 1],
        then: { workspaces: [{ left: 'T', right: 'W' }], active: 0 },
    },
    {
        id: 'user-moves#to-no-free-slot',
        given: { workspaces: [{ floating: ['W'] }, { left: 'A', right: 'B' }] },
        when: ['moveTo', 'W', 1],
        then: {
            workspaces: [{ left: 'A', right: 'B', floating: ['W'] }], active: 0,
            check: h => h.win('W').z > Math.max(h.win('A').z, h.win('B').z) ? null : 'W is not on top',
        },
    },
    {
        id: 'user-moves#floating-to-floating',
        given: { workspaces: [{ floating: ['F'] }, { floating: ['G'] }] },
        when: ['moveTo', 'F', 1],
        then: { workspaces: [{ floating: ['F', 'G'] }], active: 0 },
    },
    {
        // the user brings back a window that went right when maximized: their move wins over
        // full-alone, and it is unmaximized there (2026-10-18, Chrome in the author's session)
        id: 'user-moves#full-back-floating',
        given: { workspaces: [{ left: 'A', right: 'B', floating: ['W'] }], steps: [['maximize', 'W']] },
        when: ['moveTo', 'W', 0],
        then: { workspaces: [{ left: 'A', right: 'B', floating: ['W'] }], active: 0, focused: 'W' },
    },
    {
        id: 'user-moves#full-back-to-slot',
        given: { workspaces: [{ left: 'W', right: 'B' }, { floating: ['X'] }], active: 0, steps: [['maximize', 'W']] },
        when: ['moveTo', 'W', 0],
        then: { workspaces: [{ left: 'W', right: 'B' }, { floating: ['X'] }], active: 0 },
    },
    {
        id: 'user-moves#forgets-home',
        given: { workspaces: [{ left: 'W', right: 'B' }], steps: [['maximize', 'W'], ['moveTo', 'W', 'last']] },
        when: ['unmaximize', 'W'],
        then: { workspaces: [{ right: 'B' }, { left: 'W' }], active: 1 },
    },
    {
        id: 'user-moves#slot-it-left',
        given: { workspaces: [{ left: 'C', right: 'B', floating: ['W'] }], steps: [['tile', 'W', 'left']] },
        when: ['moveTo', 'W', 'last'],
        then: { workspaces: [{ left: 'C', right: 'B' }, { left: 'W' }], active: 1 },
    },

    // ── drag-and-snap ──────────────────────────────────────────────────────────
    {
        id: 'drag-and-snap#click',
        given: { workspaces: [{ left: 'W', right: 'B' }] },
        when: ['clickTitle', 'W'],
        then: { workspaces: [{ left: 'W', right: 'B' }], active: 0, check: h => h.unchanged('W') },
    },
    {
        id: 'drag-and-snap#detach',
        given: { workspaces: [{ left: 'W', right: 'B' }] },
        when: ['dragAway', 'W'],
        then: {
            workspaces: [{ right: 'B', floating: ['W'] }], active: 0,
            check: h => sameSize(h.rect('W'), h.share(0.3, 0.3), 24) ? null : 'W did not float at its remembered size',
        },
    },
    {
        // an app that opens at the size it was last tiled at (Nautilus, Mission Center)
        id: 'drag-and-snap#detach-reopened-tile',
        given: {
            workspaces: [{ floating: [{ name: 'W', size: [0.35, 0.45] }] }],
            steps: [['tile', 'W', 'left'], ['close', 'W'], ['open', 'W', { size: TILE }]],
        },
        when: ['dragAway', 'W'],
        then: {
            workspaces: [{ floating: ['W'] }], active: 0,
            check: h => sameSize(h.rect('W'), h.share(0.35, 0.45), 24) ? null : 'W did not float at its app\'s remembered size',
        },
    },
    {
        // its float geometry is kept partly off the screen — as a drop at an edge leaves it — and
        // it floats back wholly inside the work area, at the same size
        id: 'two-slots#untile-kept-on-screen',
        given: {
            workspaces: [{ floating: [{ name: 'W', size: [0.35, 0.45], place: [-0.2, 0.3] }] }],
            steps: [['tile', 'W', 'left']],
        },
        when: ['tile', 'W', 'left'],
        then: {
            workspaces: [{ floating: ['W'] }], active: 0,
            check: h => {
                const r = h.rect('W'), wa = h.wa;
                if (r.x < wa.x || r.y < wa.y || r.x + r.width > wa.x + wa.width || r.y + r.height > wa.y + wa.height)
                    return `W floats partly off the work area at ${r.x},${r.y}`;
                return sameSize(r, h.share(0.35, 0.45), 24) ? null : 'W did not keep its size';
            },
        },
    },
    {
        id: 'two-slots#untile-reopened-tile',
        given: {
            workspaces: [{ floating: [{ name: 'W', size: [0.35, 0.45] }] }],
            steps: [['tile', 'W', 'left'], ['close', 'W'], ['open', 'W', { size: TILE }]],
        },
        when: ['tile', 'W', 'left'],
        then: {
            workspaces: [{ floating: ['W'] }], active: 0,
            check: h => sameSize(h.rect('W'), h.share(0.35, 0.45), 24) ? null : 'W did not float at its app\'s remembered size',
        },
    },
    {
        id: 'drag-and-snap#drop-at-edge',
        given: { workspaces: [{ floating: ['W'] }] },
        when: ['drag', 'W', 'left'],
        then: { workspaces: [{ left: 'W' }], active: 0 },
    },
    {
        id: 'drag-and-snap#drop-at-top',
        given: { workspaces: [{ floating: ['W'] }] },
        when: ['drag', 'W', 'top'],
        then: { workspaces: [{ full: 'W' }], active: 0 },
    },
    {
        id: 'drag-and-snap#drop-elsewhere',
        given: { workspaces: [{ floating: ['W'] }] },
        when: ['drag', 'W', [0.65, 0.55]],
        then: {
            workspaces: [{ floating: ['W'] }], active: 0,
            check: h => sameRect(h.rect('W'), h.before.rect('W')) ? 'W did not move' : null,
        },
    },

    // ── emptied-workspace ──────────────────────────────────────────────────────
    {
        id: 'emptied-workspace#go-left',
        skip: { planner: 'leaving an emptied workspace is the windows adapter\'s, not the planner\'s' },
        given: { workspaces: [{ floating: ['P'] }, { floating: ['W'] }], active: 1, settings: { 'on-empty-workspace': 'prev' } },
        when: ['close', 'W'],
        then: { workspaces: [{ floating: ['P'] }], active: 0 },
    },
    {
        id: 'emptied-workspace#leftmost',
        skip: { planner: 'leaving an emptied workspace is the windows adapter\'s, not the planner\'s' },
        given: { workspaces: [{ floating: ['W'] }, { floating: ['Q'] }], settings: { 'on-empty-workspace': 'prev' } },
        when: ['close', 'W'],
        then: { workspaces: [{ floating: ['Q'] }], active: 0 },
    },
    {
        id: 'emptied-workspace#emptied-by-the-extension',
        skip: { vm: 'the same as going-home#unmaximize-to-free-slot', planner: 'the same as going-home#unmaximize-to-free-slot' },
        given: { workspaces: [{}] },
        when: ['close', 'W'],
        then: {},
    },
    {
        id: 'emptied-workspace#last-workspace',
        skip: { planner: 'the overview is not the planner\'s' },
        given: { workspaces: [{ floating: ['P'] }], settings: { 'overview-on-last-workspace': true } },
        when: ['activate', 'last'],
        then: { check: h => h.overview ? null : 'the overview did not open' },
    },

    // ── secondary-monitors ─────────────────────────────────────────────────────
    ...['key-tiles', 'edge-drop', 'nothing-arranged'].map(s => ({
        id: `secondary-monitors#${s}`,
        skip: { vm: 'the test machine has one monitor', planner: 'the wall is the primary monitor\'s' },
        given: { workspaces: [{}] }, when: ['open', 'W'], then: {},
    })),

    // ── with Google Chrome ─────────────────────────────────────────────────────
    {
        // Chrome was moved on past its home in the author's session (2026-10-18)
        id: 'going-home#untile-alone', group: 'chrome',
        given: {
            workspaces: [{ left: 'A', right: 'B', floating: [{ name: 'C1', app: 'chrome', size: [0.5, 0.6] }] }],
            // the author's own sequence, from the journal
            steps: [['maximize', 'C1'], ['tile', 'C1', 'left'], ['tile', 'C1', 'right'], ['tile', 'C1', 'right'],
                    ['tile', 'C1', 'right'], ['tile', 'C1', 'right'], ['maximize', 'C1'], ['tile', 'C1', 'left']],
        },
        when: ['tile', 'C1', 'left'],
        then: { workspaces: [{ left: 'A', right: 'B', floating: ['C1'] }], active: 0, focused: 'C1' },
    },
    {
        id: 'going-home#unmaximize-to-free-slot', group: 'chrome',
        given: { workspaces: [{ left: { name: 'C1', app: 'chrome' }, right: 'B' }], steps: [['maximize', 'C1']] },
        when: ['unmaximize', 'C1'],
        then: {
            workspaces: [{ left: 'C1', right: 'B' }], active: 0,
            // Chrome puts back the position it had before maximizing once the tile is applied
            check: h => Math.abs(h.rect('C1').x - h.wa.x) <= 12 ? null : 'Chrome moved itself out of its slot',
        },
    },
    {
        id: 'role-by-size#session-restore', group: 'chrome',
        given: {
            workspaces: [{ floating: ['X'] }],
            steps: [['open', 'C1', { app: 'chrome', maximized: true }], ['activate', 0],
                    ['open', 'C2', { app: 'chrome', maximized: true }], ['activate', 0], ['chromeQuit']],
        },
        when: ['chromeRestore', ['C1', 'C2']],
        then: {
            check: h => {
                const a = h.win('C1'), b = h.win('C2'), x = h.win('X');
                if (!a?.full || !b?.full) return 'C1 and C2 did not come back maximized';
                if (a.ws === b.ws || a.ws === x.ws || b.ws === x.ws) return 'C1 and C2 do not each have a workspace of their own';
                return null;
            },
        },
    },
    {
        id: 'drag-and-snap#drop-at-edge', group: 'chrome',
        given: { workspaces: [{}], steps: [['open', 'C1', { app: 'chrome', tabs: ['T2'], size: [0.5, 0.6] }]] },
        when: ['dragTab', 'C1', { index: 1, tabs: 2, to: 'left' }],
        then: {
            check: h => {
                const t = h.win('T2');
                if (!t) return 'no window for the dragged tab';
                return t.role === 'left' ? null : `the tab's window was not tiled (it is ${t.role})`;
            },
        },
    },

    // ── with Android ───────────────────────────────────────────────────────────
    // An Android window is a maximized surface whatever its app does inside it, so these judge by
    // checks, not by the workspaces' layout, which would read every one of them as full.
    {
        id: 'android-windows#full-screen-own-workspace', group: 'android',
        given: { workspaces: [{ floating: ['X'] }], steps: [['android', 'com.android.settings', 'Settings']] },
        when: ['androidFull', 'Settings', 'com.android.settings'],
        then: {
            check: h => {
                const s = h.win('Settings'), x = h.win('X');
                if (!s) return 'no Settings window';
                if (s.ws === x.ws) return 'Settings stayed on the workspace of X';
                return h.active === s.ws ? null : `the view is on ${h.active}, not on Settings' workspace ${s.ws}`;
            },
        },
    },
    {
        id: 'android-windows#floating-left-alone', group: 'android',
        given: { workspaces: [{ left: 'A', right: 'B' }] },
        when: ['android', 'com.android.settings', 'Settings'],
        then: {
            check: h => {
                if (h.win('A').role !== 'left' || h.win('B').role !== 'right') return 'A or B lost its slot';
                if (h.win('Settings')?.ws !== 0) return 'Settings did not stay where it opened';
                return h.active === 0 ? null : 'the view moved';
            },
        },
    },
    {
        id: 'android-windows#recreated-keeps-place', group: 'android',
        given: {
            workspaces: [{ floating: ['X'] }],
            steps: [['android', 'com.android.settings', 'Settings'], ['androidFull', 'Settings', 'com.android.settings']],
        },
        when: ['androidTheme', 'dark'],
        then: {
            check: h => {
                const s = h.win('Settings'), was = h.before.win?.('Settings');
                if (!s) return 'no Settings window after the theme changed';
                if (s.ws === h.win('X').ws) return 'the recreated window came back onto the workspace of X';
                return h.active === s.ws ? null : 'the view left the recreated window';
            },
        },
    },
    {
        id: 'android-windows#back-to-floating', group: 'android',
        given: {
            workspaces: [{ floating: ['X'] }],
            steps: [['android', 'com.android.settings', 'Settings'], ['androidFull', 'Settings', 'com.android.settings']],
        },
        when: ['androidFloat', 'Settings', 'com.android.settings'],
        then: {
            check: h => {
                const s = h.win('Settings');
                if (s?.ws !== h.win('X').ws) return 'Settings did not go back to the workspace of X';
                return h.active === s.ws ? null : 'the view did not go back with it';
            },
        },
    },

    // ── window-rules ───────────────────────────────────────────────────────────
    {
        id: 'window-rules#own-workspace',
        given: {
            workspaces: [{ floating: ['X'] }],
            settings: { 'window-rules': 'own-workspace:Steam' },
            steps: [['open', 'Steam1'], ['activate', 0]],
        },
        when: ['open', 'Steam2'],
        then: { workspaces: [{ floating: ['X'] }, { floating: ['Steam1', 'Steam2'] }], active: 1 },
    },
    {
        id: 'window-rules#own-workspace-first',
        given: { workspaces: [{ floating: ['X'] }], settings: { 'window-rules': 'own-workspace:Steam' } },
        when: ['open', 'Steam1'],
        then: { workspaces: [{ floating: ['X'] }, { floating: ['Steam1'] }], active: 1 },
    },
    {
        id: 'window-rules#left-alone',
        given: { workspaces: [{ left: 'A', right: 'B' }], settings: { 'window-rules': 'ignore:Ignored' } },
        when: ['open', 'Ignored', { size: TILE }],
        then: { workspaces: [{ left: 'A', right: 'B', floating: ['Ignored'] }], active: 0 },
    },
    {
        id: 'window-rules#closed',
        given: { workspaces: [{ left: 'A', right: 'B' }], settings: { 'window-rules': 'close:Closed' } },
        // gone: closed as it appears, so it is not waited for
        when: ['open', 'Closed', { maximized: true, gone: true }],
        then: { workspaces: [{ left: 'A', right: 'B' }], active: 0 },
    },

    // ── read-back-at-enable ────────────────────────────────────────────────────
    {
        id: 'read-back-at-enable#tiles-read-back',
        given: { workspaces: [{ left: 'A', right: 'B' }], steps: [['reenable']] },
        when: ['resizeEdge', 'A', 0.6],
        then: {
            workspaces: [{ left: 'A', right: 'B' }], active: 0,
            check: h => Math.abs(h.rect('A').width - 0.6 * h.wa.width) > 12 ? 'A was not resized'
                : Math.abs(h.rect('A').width + h.rect('B').width - h.wa.width) <= 12
                && h.rect('A').x + h.rect('A').width <= h.rect('B').x + 12 ? null : 'B does not fill what A leaves',
        },
        skip: { planner: 'turning the extension off and on is the windows adapter\'s, not the planner\'s' },
    },
    {
        id: 'read-back-at-enable#lone-tile-read-back',
        given: { workspaces: [{ left: 'W' }], steps: [['reenable']] },
        when: ['tile', 'W', 'left'],
        then: { workspaces: [{ floating: ['W'] }], active: 0 },
        skip: { planner: 'turning the extension off and on is the windows adapter\'s, not the planner\'s' },
    },
];
