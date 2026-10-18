/* snapshot.js — the planner's view of the wall, built from the live windows.
 *
 * Fresh for every plan, never cached. Of the primary monitor only: the wall is that monitor's.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const toRect = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });

export function take(registry, floatSizes, opening = []) {
    const wm = global.workspace_manager;
    const monitor = global.display.get_primary_monitor();
    const managed = registry.windows().filter(w =>
        (registry.get(w).placed || opening.includes(w)) &&
        w.get_monitor() === monitor && !w.is_on_all_workspaces() && w.get_workspace());
    const stacking = global.display.sort_windows_by_stacking(managed);

    const workspaces = [];
    for (let i = 0; i < wm.get_n_workspaces(); i++) {
        const ws = wm.get_workspace_by_index(i);
        const windows = managed.filter(w => w.get_workspace() === ws).map(w => {
            const rec = registry.get(w);
            const live = toRect(w.get_frame_rect());
            // a tile is where it was put: an app takes a moment to accept a new size, and the
            // live rect read meanwhile would have the planner undo the tile it just made
            const tiled = rec.role === 'tiled-left' || rec.role === 'tiled-right';
            const rect = tiled && rec.tileRect && !w.minimized ? { ...rec.tileRect } : live;
            const parent = w.get_transient_for();
            return {
                win: w, role: rec.role, rect, z: stacking.indexOf(w),
                minimized: w.minimized, fullscreen: w.fullscreen, above: w.above,
                home: rec.home, preFull: rec.preFull, minimizedFrom: rec.minimizedFrom,
                // a floating window's geometry is the one it has now — but for one just opening,
                // which may have opened at the size it was last tiled at (windows#register)
                floatRect: rec.role === 'floating' && !w.minimized && !opening.includes(w) ? live : rec.floatRect,
                appFloatSize: floatSizes[w.get_wm_class()] ?? null,
                minWidth: rec.minWidth, ownWsRule: rec.ownWsRule,
                transientFor: !!(parent && registry.get(parent)),
            };
        });
        workspaces.push({ ws, windows });
    }
    const active = wm.get_active_workspace();
    return {
        workArea: toRect(active.get_work_area_for_monitor(monitor)),
        activeWs: active,
        workspaces,
    };
}
