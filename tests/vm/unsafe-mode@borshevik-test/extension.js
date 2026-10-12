// Test machines only: lets org.gnome.Shell.Eval answer, so tests/vm.sh can read the shell's state.
export default class {
    enable()  { global.context.unsafe_mode = true; }
    disable() { global.context.unsafe_mode = false; }
}
