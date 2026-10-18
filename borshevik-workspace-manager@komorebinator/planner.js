/* planner.js — every decision about where a window goes, as pure functions.
 *
 * A snapshot of the primary monitor's wall and an intent in, a plan out. Imports nothing from
 * gi://: workspaces and windows are opaque references, compared but never called, so this runs
 * under plain gjs and the scenarios can be checked against it without a GNOME Shell.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const FULL_SHARE = 0.9;
export const TILE_SHARE = [0.2, 0.8];
const MIN_PARTNER = 50;

// ── the wall ─────────────────────────────────────────────────────────────────
//
// A working copy of the snapshot that the decisions change as they are taken, so that every later
// decision of the same plan sees the wall as the earlier ones left it.

function copyWall(snapshot) {
    const wall = {
        wa: snapshot.workArea,
        activeWs: snapshot.activeWs,
        workspaces: snapshot.workspaces.map(s => ({ ws: s.ws, windows: [] })),
        byWin: new Map(),
        ops: [],
        view: null,
        touched: new Set(),
        newRefs: 0,
        seq: 0,
        opening: new Set(),
        notes: [],
    };
    snapshot.workspaces.forEach((s, i) => {
        for (const w of s.windows) {
            const c = { ...w, rect: { ...w.rect }, home: w.home ? { ...w.home } : null };
            wall.workspaces[i].windows.push(c);
            wall.byWin.set(w.win, c);
            if (w.home?.seq > wall.seq) wall.seq = w.home.seq;
        }
    });
    return wall;
}

const isTile = w => w.role === 'tiled-left' || w.role === 'tiled-right';
const sideOf = w => (w.role === 'tiled-left' ? 'left' : w.role === 'tiled-right' ? 'right' : null);
const other = side => (side === 'left' ? 'right' : 'left');
const visible = w => !w.minimized;

function indexOf(wall, w) {
    return wall.workspaces.findIndex(s => s.windows.includes(w));
}

function indexOfWs(wall, ws) {
    return wall.workspaces.findIndex(s => s.ws === ws);
}

// The tiles in a workspace's slots, leaving out `except`: a window being placed still has its old
// role — a restored one its slot, now taken by another — and which of two the loop found last
// would depend on the order the windows were registered in.
function tiles(slot, except = null) {
    const t = { left: null, right: null };
    for (const w of slot.windows) {
        if (w !== except && visible(w) && isTile(w)) t[sideOf(w)] = w;
    }
    return t;
}

const fullOf = slot => slot.windows.find(w => visible(w) && w.role === 'full') ?? null;
const guestsOf = slot => slot.windows.filter(w => visible(w) && w.role === 'floating');

function kind(slot) {
    if (!slot.windows.length) return 'empty';
    if (fullOf(slot)) return 'full';
    if (Object.values(tiles(slot)).some(Boolean)) return 'tile';
    return 'floating';
}

function emit(wall, op) {
    wall.ops.push(op);
}

function touch(wall, i) {
    if (i >= 0) wall.touched.add(wall.workspaces[i].ws);
}

function topZ(wall) {
    let z = 0;
    for (const s of wall.workspaces) for (const w of s.windows) z = Math.max(z, w.z ?? 0);
    return z;
}

// A new workspace beside slot i, before or after it; returns its index.
function newWorkspace(wall, i, where) {
    const ref = { newWorkspace: ++wall.newRefs };
    const anchor = wall.workspaces[i].ws;
    emit(wall, where === 'before' ? { op: 'newWorkspace', ref, before: anchor } : { op: 'newWorkspace', ref, after: anchor });
    const at = where === 'before' ? i : i + 1;
    wall.workspaces.splice(at, 0, { ws: ref, windows: [] });
    return at;
}

function move(wall, w, to) {
    const from = indexOf(wall, w);
    if (from === to) return;
    wall.workspaces[from].windows.splice(wall.workspaces[from].windows.indexOf(w), 1);
    wall.workspaces[to].windows.push(w);
    emit(wall, { op: 'move', win: w.win, ws: wall.workspaces[to].ws });
    touch(wall, from);
    touch(wall, to);
}

function setHome(wall, w, home) {
    w.home = home;
    emit(wall, { op: 'home', win: w.win, home });
}

function tileRect(wa, side, width) {
    const wdt = Math.round(Math.min(width, wa.width));
    return { x: side === 'left' ? wa.x : wa.x + wa.width - wdt, y: wa.y, width: wdt, height: wa.height };
}

// A floating window's geometry is kept on its record as it stops floating, for when it floats again.
// Not as it opens: some apps open at the size they were last tiled at, which is no float size.
function keepFloatRect(wall, w) {
    if (w.role !== 'floating' || wall.opening.has(w)) return;
    w.floatRect = { ...w.rect };
    emit(wall, { op: 'floatRect', win: w.win, rect: { ...w.rect } });
}

function setTile(wall, w, side, width) {
    keepFloatRect(wall, w);
    w.role = `tiled-${side}`;
    w.rect = tileRect(wall.wa, side, width);
    emit(wall, { op: 'tile', win: w.win, side, rect: { ...w.rect } });
    touch(wall, indexOf(wall, w));
}

// The width a tile gets beside a partner: what the partner leaves.
function besideWidth(wall, partner) {
    return wall.wa.width - partner.rect.width;
}

// Its own floating geometry first, else its app's size centred; a detached one takes its app's
// size first, the size the user last chose for the app by hand.
function floatRect(wall, w, { appFirst = false } = {}) {
    if (w.floatRect && !(appFirst && w.appFloatSize)) return onScreen(wall, w.floatRect);
    if (w.appFloatSize) {
        const width = Math.round(wall.wa.width * w.appFloatSize.wr);
        const height = Math.round(wall.wa.height * w.appFloatSize.hr);
        return {
            x: wall.wa.x + Math.round((wall.wa.width - width) / 2),
            y: wall.wa.y + Math.round((wall.wa.height - height) / 2),
            width, height,
        };
    }
    return null;
}

// Shifted, and if need be shrunk, to lie wholly inside the work area: a geometry kept as the window
// stopped floating may hang off it — a drop at an edge keeps the window pushed against it — and so
// may one kept before the screen changed.
function onScreen(wall, r) {
    const wa = wall.wa;
    const width = Math.min(r.width, wa.width), height = Math.min(r.height, wa.height);
    return {
        x: Math.min(Math.max(r.x, wa.x), wa.x + wa.width - width),
        y: Math.min(Math.max(r.y, wa.y), wa.y + wa.height - height),
        width, height,
    };
}

function setFloat(wall, w, { keepPosition = false, appFirst = false } = {}) {
    w.role = 'floating';
    const rect = floatRect(wall, w, { appFirst });
    if (rect && keepPosition) {
        rect.x = w.rect.x;
        rect.y = w.rect.y;
    }
    if (rect) w.rect = rect;
    emit(wall, { op: 'float', win: w.win, rect, keepPosition });
    touch(wall, indexOf(wall, w));
}

function setFull(wall, w) {
    keepFloatRect(wall, w);
    if (w.role !== 'full') w.preFull = w.role;
    w.role = 'full';
    w.rect = { ...wall.wa };
    emit(wall, { op: 'full', win: w.win, preFull: w.preFull });
    touch(wall, indexOf(wall, w));
}

function raise(wall, w) {
    w.z = topZ(wall) + 1;
    emit(wall, { op: 'raise', win: w.win });
}

function lowerBelowGuests(wall, w, slot) {
    const guests = guestsOf(slot).filter(g => g !== w);
    if (!guests.length) return;
    w.z = Math.min(...guests.map(g => g.z ?? 0)) - 1;
    emit(wall, { op: 'lower', win: w.win, below: guests.map(g => g.win) });
}

function show(wall, i) {
    wall.view = wall.workspaces[i].ws;
}

// ── role-by-size ─────────────────────────────────────────────────────────────

export function _roleBySize(rect, wa) {
    const wr = rect.width / wa.width;
    const hr = rect.height / wa.height;
    if (wr > FULL_SHARE && hr > FULL_SHARE) return { role: 'full' };
    if (hr > FULL_SHARE && wr >= TILE_SHARE[0] && wr <= TILE_SHARE[1]) {
        const side = rect.x + rect.width / 2 > wa.x + wa.width / 2 ? 'right' : 'left';
        return { role: 'tile', side };
    }
    return { role: 'floating' };
}

// ── neighbours ───────────────────────────────────────────────────────────────

// Whether the slot at index i can take tile w coming from the workspace `origin` (a ws ref):
// empty, or a tile workspace with a free slot whose tiles all share that origin, where w would
// cover no guest completely. Returns the side to take, or null.
function _neighbour(wall, i, w, origin, preferred) {
    const slot = wall.workspaces[i];
    if (!slot) return null;
    if (kind(slot) === 'empty') return preferred;
    if (kind(slot) !== 'tile') return null;
    const t = tiles(slot);
    const present = [t.left, t.right].filter(Boolean);
    if (!present.every(x => x.home?.ws === origin)) return null;
    const side = !t[preferred] ? preferred : !t[other(preferred)] ? other(preferred) : null;
    if (!side) return null;
    const partner = t[other(side)];
    const rect = tileRect(wall.wa, side, partner ? besideWidth(wall, partner) : w.rect.width);
    const covers = guestsOf(slot).some(g => hides(wall, g, [{ rect, z: Infinity }]));
    return covers ? null : side;
}

// ── placement ────────────────────────────────────────────────────────────────

// A window that became blocking where there is no room goes right, and the view goes with it.
function _goRight(wall, w, role, side) {
    const i = indexOf(wall, w);
    const origin = wall.workspaces[i].ws;
    const prevSide = sideOf(w);
    let to;
    if (role === 'full') {
        to = wall.workspaces[i + 1] && kind(wall.workspaces[i + 1]) === 'empty' ? i + 1 : newWorkspace(wall, i, 'after');
    } else {
        const taken = _neighbour(wall, i + 1, w, origin, side);
        if (taken) side = taken;
        to = taken ? i + 1 : newWorkspace(wall, i, 'after');
    }
    if (prevSide) freeSlotLater(wall, origin, prevSide);
    move(wall, w, to);
    setHome(wall, w, { ws: origin, kind: 'with-user', slot: prevSide });
    if (role === 'full') {
        setFull(wall, w);
    } else {
        const partner = tiles(wall.workspaces[to], w)[other(side)];
        setTile(wall, w, side, partner ? besideWidth(wall, partner) : wall.wa.width / 2);
    }
    show(wall, to);
}

// Slots freed while a decision is in progress are handed back once it is done, so a window
// coming back never lands in the middle of a move it is part of.
function freeSlotLater(wall, ws, side) {
    (wall.freed ??= []).push({ ws, side });
}

function flushFreed(wall) {
    while (wall.freed?.length) {
        const { ws, side } = wall.freed.shift();
        _freeSlot(wall, ws, side);
    }
}

function _displace(wall, occupant, side) {
    const i = indexOf(wall, occupant);
    const origin = wall.workspaces[i].ws;
    const taken = i > 0 ? _neighbour(wall, i - 1, occupant, origin, side) : null;
    const to = taken ? i - 1 : newWorkspace(wall, i, 'before');
    const landSide = taken ?? side;
    move(wall, occupant, to);
    setHome(wall, occupant, { ws: origin, kind: 'displaced', slot: side, seq: ++wall.seq });
    const partner = tiles(wall.workspaces[to], occupant)[other(landSide)];
    setTile(wall, occupant, landSide, partner ? besideWidth(wall, partner) : occupant.rect.width);
}

export function _tile(wall, w, side, explicit) {
    let i = indexOf(wall, w);
    const slot = wall.workspaces[i];
    const full = fullOf(slot);
    if (full && full !== w) {
        _goRight(wall, w, 'tile', side);
        return;
    }
    if (explicit && w.role === 'floating') {
        w.floatRect = { ...w.rect };
        emit(wall, { op: 'floatSize', win: w.win, rect: { ...w.rect } });
    }
    const t = tiles(slot, w);
    const occupant = t[side], partner = t[other(side)];
    if (!occupant) {
        let width = partner ? besideWidth(wall, partner) : explicit ? wall.wa.width / 2
            : Math.min(w.rect.width, Math.floor(wall.wa.width * TILE_SHARE[1]));
        setTile(wall, w, side, width);
        return;
    }
    if (!partner) {
        const keep = occupant.rect.width;
        setTile(wall, occupant, other(side), keep);
        setTile(wall, w, side, wall.wa.width - keep);
        return;
    }
    if (!explicit) {
        _goRight(wall, w, 'tile', side);
        return;
    }
    _displace(wall, occupant, side);
    i = indexOf(wall, w);
    setTile(wall, w, side, besideWidth(wall, partner));
}

function hasOthers(slot, w) {
    return slot.windows.some(x => x !== w && visible(x));
}

export function _becomeFull(wall, w) {
    if (w.role === 'full') return;
    const i = indexOf(wall, w);
    if (hasOthers(wall.workspaces[i], w)) {
        _goRight(wall, w, 'full');
    } else {
        setFull(wall, w);
        show(wall, i);
    }
}

function _opened(wall, w, opened) {
    const i = indexOf(wall, w);
    const slot = wall.workspaces[i];
    if (w.ownWsRule) {
        const j = wall.workspaces.findIndex((s, k) => s.windows.some(x => x !== w && x.ownWsRule === w.ownWsRule && !opened.has(x)));
        if (j >= 0) {
            move(wall, w, j);
            show(wall, j);
        } else if (hasOthers(slot, w)) {
            const to = newWorkspace(wall, i, 'after');
            move(wall, w, to);
            show(wall, to);
        }
        return;
    }
    const judged = w.role === 'full' ? { role: 'full' } : _roleBySize(w.rect, wall.wa);
    if (judged.role === 'full') {
        if (hasOthers(slot, w)) {
            if (w.role !== 'full') w.preFull = 'floating';
            _goRight(wall, w, 'full');
        } else {
            setFull(wall, w);
        }
    } else if (judged.role === 'tile') {
        const t = tiles(slot);
        if (fullOf(slot)) {
            _goRight(wall, w, 'tile', judged.side);
            return;
        }
        const side = !t[judged.side] ? judged.side : !t[other(judged.side)] ? other(judged.side) : null;
        if (side) _tile(wall, w, side, false);
        else _goRight(wall, w, 'tile', judged.side);
    }
}

// ── going home and coming back ───────────────────────────────────────────────

export function _freeSlot(wall, ws, side) {
    const i = indexOfWs(wall, ws);
    if (i < 0) return;
    const slot = wall.workspaces[i];
    if (fullOf(slot) || tiles(slot)[side]) return;
    const candidates = [];
    for (const s of wall.workspaces)
        for (const w of s.windows)
            if (w.home?.kind === 'displaced' && w.home.ws === ws && w.home.slot === side && isTile(w) && visible(w))
                candidates.push(w);
    if (!candidates.length) return;
    const back = candidates.reduce((a, b) => (b.home.seq > a.home.seq ? b : a));
    const there = wall.workspaces[indexOf(wall, back)];
    const companion = tiles(there)[other(sideOf(back))];
    if (companion && companion.home?.ws !== ws) return; // a pair the user made is not torn apart
    move(wall, back, i);
    setHome(wall, back, null);
    const partner = tiles(slot, back)[other(side)];
    setTile(wall, back, side, partner ? besideWidth(wall, partner) : back.rect.width);
    lowerBelowGuests(wall, back, slot);
    if (companion?.home?.kind === 'displaced' && companion.home.ws === ws && !tiles(slot)[companion.home.slot])
        _freeSlot(wall, ws, companion.home.slot);
}

// A window stopped being blocking: unmaximized, out of fullscreen, or detached by a drag.
export function _stopBlocking(wall, w, how) {
    const i = indexOf(wall, w);
    const prevSide = sideOf(w);
    const prev = w.role === 'full' ? (w.preFull ?? 'floating') : w.role;
    const home = w.home;
    const homeAt = home ? indexOfWs(wall, home.ws) : -1;
    if (how === 'detached') {
        if (prevSide) freeSlotLater(wall, wall.workspaces[i].ws, prevSide);
        setFloat(wall, w, { keepPosition: true, appFirst: true });
        if (home?.kind === 'displaced') {
            setHome(wall, w, null);
        } else if (home?.kind === 'with-user' && homeAt >= 0 && homeAt !== i
                   && wall.workspaces[i].windows.every(x => x === w || x.home?.ws === home.ws)) {
            move(wall, w, homeAt);
            setHome(wall, w, null);
            show(wall, homeAt);
        }
        flushFreed(wall);
        return;
    }
    // unfull
    const prevTile = prev === 'tiled-left' ? 'left' : prev === 'tiled-right' ? 'right' : null;
    if (home?.kind === 'with-user' && homeAt >= 0 && homeAt !== i) {
        const homeSlot = wall.workspaces[homeAt];
        if (prevTile && !fullOf(homeSlot) && !tiles(homeSlot)[prevTile]) {
            move(wall, w, homeAt);
            setHome(wall, w, null);
            const partner = tiles(homeSlot)[other(prevTile)];
            setTile(wall, w, prevTile, partner ? besideWidth(wall, partner) : wall.wa.width / 2);
            show(wall, homeAt);
            return;
        }
        // a full window at home keeps out a tile, not a guest: one that floated there before
        // floats there again, on top
        if (!prevTile) {
            move(wall, w, homeAt);
            setHome(wall, w, null);
            setFloat(wall, w);
            raise(wall, w);
            show(wall, homeAt);
            return;
        }
    }
    // home taken or none: the previous role, where it is
    const slot = wall.workspaces[i];
    if (prevTile && !tiles(slot)[prevTile]) {
        const partner = tiles(slot)[other(prevTile)];
        setTile(wall, w, prevTile, partner ? besideWidth(wall, partner) : wall.wa.width / 2);
    } else {
        setFloat(wall, w);
    }
}

// ── guests ───────────────────────────────────────────────────────────────────

// Whether guest g is hidden completely by `covers` (tiles and full windows, each {rect, z}).
// One dimension is enough: everything that covers is as tall as the work area.
function hides(wall, g, covers) {
    const wa = wall.wa, r = g.rect;
    const left = Math.max(r.x, wa.x), right = Math.min(r.x + r.width, wa.x + wa.width);
    const top = Math.max(r.y, wa.y), bottom = Math.min(r.y + r.height, wa.y + wa.height);
    if (left >= right || top >= bottom) return true;
    const spans = covers
        .filter(c => (c.z ?? 0) > (g.z ?? 0) && c.rect.y < r.y + r.height && c.rect.y + c.rect.height > r.y)
        .map(c => [c.rect.x, c.rect.x + c.rect.width])
        .sort((a, b) => a[0] - b[0]);
    let reached = left;
    for (const [s, e] of spans) {
        if (s > reached) return false;
        reached = Math.max(reached, e);
        if (reached >= right) return true;
    }
    return false;
}

export function _isCovered(wall, slot, g) {
    const covers = slot.windows.filter(w => visible(w) && (isTile(w) || w.role === 'full'));
    return covers.length > 0 && hides(wall, g, covers);
}

function freeArea(wall, slot) {
    if (fullOf(slot)) return null;
    const t = tiles(slot);
    if (t.left && t.right) return null;
    const wa = wall.wa;
    if (t.left) return { x: t.left.rect.x + t.left.rect.width, width: wa.x + wa.width - (t.left.rect.x + t.left.rect.width) };
    if (t.right) return { x: wa.x, width: t.right.rect.x - wa.x };
    return null;
}

export function _evictCovered(wall, i) {
    const slot = wall.workspaces[i];
    if (!slot) return;
    const covered = guestsOf(slot).filter(g => !g.above && !g.transientFor && _isCovered(wall, slot, g));
    if (!covered.length) return;
    // why, for the log: the guest and everything that counted as covering it
    for (const g of covered) {
        wall.notes.push({
            evicted: g.win, rect: { ...g.rect }, z: g.z,
            covers: slot.windows.filter(c => visible(c) && (isTile(c) || c.role === 'full'))
                .map(c => ({ win: c.win, role: c.role, rect: { ...c.rect }, z: c.z })),
        });
    }
    const free = freeArea(wall, slot);
    const away = [];
    for (const g of covered) {
        if (free && free.width >= 50 && g.rect.width <= free.width) {
            g.rect.x = free.x + Math.floor((free.width - g.rect.width) / 2);
            emit(wall, { op: 'place', win: g.win, x: g.rect.x, y: g.rect.y });
        } else {
            away.push(g);
        }
    }
    if (!away.length) return;
    const left = wall.workspaces[i - 1];
    const to = left && ['floating', 'empty'].includes(kind(left)) ? i - 1 : newWorkspace(wall, i, 'before');
    for (const g of away) move(wall, g, to);
}

// ── minimize ─────────────────────────────────────────────────────────────────

function _minimized(wall, w) {
    const i = indexOf(wall, w);
    const side = sideOf(w);
    w.minimized = true;
    const from = { ws: wall.workspaces[i].ws, slot: side };
    w.minimizedFrom = from;
    emit(wall, { op: 'minimizedFrom', win: w.win, value: from });
    if (side) _freeSlot(wall, wall.workspaces[i].ws, side);
}

function _restored(wall, w) {
    w.minimized = false;
    const from = w.minimizedFrom;
    emit(wall, { op: 'minimizedFrom', win: w.win, value: null });
    w.minimizedFrom = null;
    let i = indexOf(wall, w);
    const back = from ? indexOfWs(wall, from.ws) : -1;
    if (back >= 0 && back !== i) {
        move(wall, w, back);
        i = back;
    }
    if (w.role === 'full') {
        w.role = w.preFull ?? 'floating';
        _becomeFull(wall, w);
        return;
    }
    const side = sideOf(w);
    if (side) {
        _tile(wall, w, side, true);
    } else {
        raise(wall, w);
    }
    show(wall, indexOf(wall, w));
}

// ── user moves ───────────────────────────────────────────────────────────────

function _userMoved(wall, w, fromWs) {
    const i = indexOf(wall, w);
    if (w.home) setHome(wall, w, null);
    raise(wall, w);
    const prevSide = sideOf(w);
    if (prevSide && fromWs) freeSlotLater(wall, fromWs, prevSide);
    const slot = wall.workspaces[i];
    if (w.role === 'full' && !hasOthers(slot, w)) {
        flushFreed(wall);
        return;
    }
    // A full window brought among other windows is unmaximized there rather than sent away: the
    // user chose that workspace, and their move wins over full-alone. It takes the role it had
    // before, placed as any moved window is.
    const wasFull = w.role === 'full';
    if (wasFull) w.role = w.preFull ?? 'floating';
    const side = sideOf(w);
    const t = tiles(slot, w);
    if (fullOf(slot)) {
        if (side || wasFull) setFloat(wall, w);
    } else if (!t.left && !t.right) {
        if (side) setTile(wall, w, side, wasFull ? wall.wa.width / 2 : w.rect.width);
        else if (wasFull) setFloat(wall, w);
    } else if (!t.left || !t.right) {
        const free = t.left ? 'right' : 'left';
        setTile(wall, w, free, besideWidth(wall, t[other(free)]));
    } else if (side || wasFull) {
        setFloat(wall, w);
    }
    flushFreed(wall);
}

// ── fitting ──────────────────────────────────────────────────────────────────

function _fit(wall, w, width) {
    const i = indexOf(wall, w);
    const side = sideOf(w);
    if (!side) return;
    const partner = tiles(wall.workspaces[i])[other(side)];
    if (width !== undefined) setTile(wall, w, side, width);   // the width it really has now
    if (!partner) return;
    const rest = wall.wa.width - w.rect.width;
    if (rest < MIN_PARTNER) return;
    setTile(wall, partner, other(side), rest);
}

function _relayout(wall, i) {
    const slot = wall.workspaces[i];
    const t = tiles(slot);
    for (const side of ['left', 'right']) {
        const w = t[side];
        if (!w) continue;
        const want = tileRect(wall.wa, side, t[other(side)] ? w.rect.width : w.rect.width);
        const r = w.rect;
        if (r.x !== want.x || r.y !== want.y || r.height !== want.height || r.width > wall.wa.width)
            setTile(wall, w, side, Math.min(w.rect.width, wall.wa.width));
    }
}

// ── the plan ─────────────────────────────────────────────────────────────────

const USER_ACTIONS = new Set(['opened', 'tile', 'untile', 'full', 'unfull', 'detached', 'dropped', 'userMoved', 'restored', 'returnTo']);

export function plan(snapshot, intent) {
    const wall = copyWall(snapshot);
    const w = intent.win ? wall.byWin.get(intent.win) : null;
    if (intent.win && !w && intent.type !== 'returnTo')
        return { ops: [], activate: null, touched: [] };

    switch (intent.type) {
    case 'opened': {
        const opened = new Set(intent.wins.map(x => wall.byWin.get(x)).filter(Boolean));
        wall.opening = opened;
        for (const x of opened) _opened(wall, x, opened);
        break;
    }
    case 'closed': {
        if (intent.slot) _freeSlot(wall, intent.ws, intent.slot);
        break;
    }
    case 'tile': _tile(wall, w, intent.side, intent.explicit); break;
    case 'untile': {
        const i = indexOf(wall, w);
        const side = sideOf(w);
        setFloat(wall, w);
        if (side) _freeSlot(wall, wall.workspaces[i].ws, side);
        if (w.home?.kind === 'with-user') {
            const homeAt = indexOfWs(wall, w.home.ws);
            if (homeAt >= 0 && homeAt !== indexOf(wall, w) && !hasOthers(wall.workspaces[indexOf(wall, w)], w)) {
                // on top, as a window back from full is (_stopBlocking): under the tiles at home
                // it would be found covered and moved on at once
                move(wall, w, homeAt);
                setHome(wall, w, null);
                raise(wall, w);
                show(wall, homeAt);
            }
        }
        break;
    }
    case 'full': _becomeFull(wall, w); break;
    case 'unfull': _stopBlocking(wall, w, 'unfull'); break;
    case 'detached': _stopBlocking(wall, w, 'detached'); break;
    case 'dropped':
        if (intent.zone === 'maximize') {
            _becomeFull(wall, w);
        } else {
            _tile(wall, w, intent.zone, true);
        }
        break;
    case 'userMoved': _userMoved(wall, w, intent.from); break;
    case 'minimized': _minimized(wall, w); break;
    case 'restored': _restored(wall, w); break;
    case 'resized': _fit(wall, w, intent.width); break;
    case 'settled': _fit(wall, w, intent.width); break;
    case 'recheck': {
        const i = indexOfWs(wall, intent.ws);
        if (i >= 0) {
            if (intent.relayout) _relayout(wall, i);
            touch(wall, i);
        }
        break;
    }
    case 'returnTo': {
        emit(wall, { op: 'move', win: intent.win, ws: intent.ws });
        if (intent.show) wall.view = intent.ws;
        break;
    }
    }
    flushFreed(wall);

    for (const ws of [...wall.touched]) {
        const i = indexOfWs(wall, ws);
        if (i >= 0) _evictCovered(wall, i);
    }

    // The view goes with the window the user acted on, never off a fullscreen window.
    let activate = USER_ACTIONS.has(intent.type) ? wall.view : null;
    if (activate && intent.type === 'opened' && !intent.wins.some(x => snapshotWsOf(snapshot, x) === snapshot.activeWs))
        activate = null;
    if (activate && fullscreenElsewhere(snapshot, intent)) activate = null;
    if (activate === snapshot.activeWs) activate = null;
    return { ops: wall.ops, activate, focus: focusOf(wall, intent, activate), touched: [...wall.touched], notes: wall.notes };
}

// The window to focus as the view goes with it: the one the user acted on — or the first window
// opened — if it is on the workspace shown. Showing a workspace alone leaves the focus to GNOME,
// which, when focus follows the mouse, gives it to whatever is under the pointer, or to nothing.
function focusOf(wall, intent, activate) {
    if (!activate) return null;
    if (intent.type === 'returnTo') return intent.win;
    const wins = intent.type === 'opened' ? intent.wins : intent.win ? [intent.win] : [];
    for (const win of wins) {
        const w = wall.byWin.get(win);
        const i = w ? indexOf(wall, w) : -1;
        if (i >= 0 && wall.workspaces[i].ws === activate && !w.minimized) return win;
    }
    return null;
}

function snapshotWsOf(snapshot, win) {
    return snapshot.workspaces.find(s => s.windows.some(w => w.win === win))?.ws ?? null;
}

// Whether the active workspace shows a fullscreen window other than the one the intent is about.
function fullscreenElsewhere(snapshot, intent) {
    const active = snapshot.workspaces.find(s => s.ws === snapshot.activeWs);
    const subjects = new Set(intent.wins ?? [intent.win]);
    return !!active?.windows.some(w => w.fullscreen && !w.minimized && !subjects.has(w.win));
}
