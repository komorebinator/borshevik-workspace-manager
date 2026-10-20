/* workspaces.js — telling the workspaces GNOME still has from those it has removed.
 *
 * A removed workspace lives on as an object for as long as something holds it, and index() on it
 * fails Mutter's assertion, a critical in the journal each time: it is told by the workspaces
 * still there instead.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function liveWorkspaces() {
    const wm = global.workspace_manager;
    return new Set(Array.from({ length: wm.get_n_workspaces() }, (_, i) => wm.get_workspace_by_index(i)));
}

export function isLive(ws) {
    return !!ws && liveWorkspaces().has(ws);
}

// The handlers of removed workspaces, disconnected and dropped from a list of [workspace, handler
// id]: kept, they would pile up for as long as the extension is on.
export function dropRemovedWorkspaces(handles) {
    const live = liveWorkspaces();
    return handles.filter(([ws, id]) => {
        if (live.has(ws)) return true;
        try { ws.disconnect(id); } catch {}
        return false;
    });
}

// Its index, or -1 once removed — for the log above all, whose arguments are worked out even
// while it is off.
export function wsIndex(ws) {
    return isLive(ws) ? ws.index() : -1;
}
