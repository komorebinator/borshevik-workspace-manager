/* log.js — the debug log every module writes to.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

let enabled = false;

export function setLogging(on) {
    enabled = on;
}

export function LOG(...args) {
    if (enabled) console.log('[BWM]', ...args);
}

export const logging = () => enabled;

// A window as the log names it: its class and Mutter's id, so two windows of one app — Chrome's
// several — can be told apart.
export function name(win) {
    if (!win) return '-';
    try { return `${win.get_wm_class?.() ?? '?'}#${win.get_id?.()}`; } catch { return '?'; }
}
