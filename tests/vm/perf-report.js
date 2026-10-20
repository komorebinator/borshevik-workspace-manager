// The performance report, as GetPerfReport returns it (JSON on stdin), printed as text by the
// extension's own formatter. Runs on the host under gjs, for tests/vm.sh perf and for a report
// taken from a live session:
//
//   busctl --user --json=short call org.gnome.Shell /org/borshevik/WorkspaceManager \
//       org.borshevik.WorkspaceManager GetPerfReport | gjs -m tests/vm/perf-report.js
import GLib from 'gi://GLib';
import { formatReport } from '../../borshevik-workspace-manager@komorebinator/perf.js';

const input = new TextDecoder().decode(GLib.file_get_contents('/dev/stdin')[1]);
let report = JSON.parse(input);
if (report.data) report = JSON.parse(report.data[0]);   // busctl's reply, not yet unwrapped
print(formatReport(report));
