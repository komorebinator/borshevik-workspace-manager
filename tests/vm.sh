#!/usr/bin/env bash
# Keeps a test machine for trying the extension's working tree by hand: a GNOME session
# reached over SSH, Shell.Eval and QMP, with Android when the image is Borshevik's.
# See @BorshevikWorkspaceManagerWorkflow#test-vm in spec/. Runs on the host; needs ssh,
# skopeo, python3, podman through run0 (for `setup` only) and the GNOME Boxes flatpak's
# qemu and firmware.
set -euo pipefail

default_image=ghcr.io/komorebinator/borshevik:latest

usage() {
    cat >&2 <<EOF
usage: $0 setup [image]     make the machine's disk from a bootc image with GNOME
                             (default: $default_image)
       $0 start [image]     boot it, bring it to the image's current build, log tester in
       $0 deploy            install the working tree for tester and restart tester's session
       $0 android           install Android, or bring it up to date, and start it for tester
       $0 ssh [command]     a root shell in the machine, or a command run there as root
       $0 droid <command>   a command run as root inside Android
       $0 eval <js|file>    evaluate JavaScript in tester's GNOME Shell and print the result
       $0 state             workspaces and windows, with what the extension made of each
       $0 key <keys>...     send keys to the machine, e.g. esc or super+a
       $0 shot [file]       save a screenshot (default: screen.png in the machine's directory)
       $0 stop              power it off
EOF
    exit 2
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uuid=borshevik-workspace-manager@komorebinator
helper=unsafe-mode@bwm-test
dir="${XDG_CACHE_HOME:-$HOME/.cache}/borshevik-workspace-manager-vm"
key="$dir/id_ed25519"
mkdir -p "$dir"

die() { echo "$*" >&2; exit 1; }
boxes() { flatpak run --filesystem="$dir" --command="$1" org.gnome.Boxes "${@:2}"; }

qmp() { # command [json arguments]
    python3 - "$dir/qmp.sock" "$@" <<'PY'
import json, socket, sys
s = socket.socket(socket.AF_UNIX)
s.connect(sys.argv[1])
f = s.makefile("rw")
f.readline()
f.write(json.dumps({"execute": "qmp_capabilities"}) + "\n"); f.flush(); f.readline()
cmd = {"execute": sys.argv[2]}
if len(sys.argv) > 3:
    cmd["arguments"] = json.loads(sys.argv[3])
f.write(json.dumps(cmd) + "\n"); f.flush()
while True:
    r = json.loads(f.readline())
    if "return" in r or "error" in r:
        print(json.dumps(r)); break
PY
}

running() { [[ -S "$dir/qmp.sock" ]] && qmp query-status >/dev/null 2>&1; }
need_running() { running || die "the machine is not running; run: $0 start"; }

guest_once() {
    ssh -i "$key" -p "$(cat "$dir/port")" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o IdentitiesOnly=yes -o LogLevel=ERROR -o ConnectTimeout=5 -o ServerAliveInterval=30 \
        root@127.0.0.1 "$@"
}

# Retries when ssh itself fails (255): the forwarded port resets a connection now and then
# right after boot. Only for commands that are safe to run twice.
guest() {
    local rc
    for _ in 1 2 3 4 5; do
        guest_once "$@" && return 0 || rc=$?
        [[ "$rc" -ne 255 ]] && return "$rc"
        sleep 3
    done
    return 255
}

boot_id() { guest cat /proc/sys/kernel/random/boot_id 2>/dev/null || true; }

wait_ssh() { # previous boot id, or empty
    local old="$1" id
    for _ in $(seq 60); do
        running || die "the machine stopped; see $dir/qemu.log and $dir/serial.log"
        id="$(boot_id)"
        [[ -n "$id" && "$id" != "$old" ]] && return 0
        sleep 5
    done
    die "no SSH from the machine after five minutes"
}

settle() { # waits for a boot to finish, following any reboot that happens meanwhile
    local id now
    for _ in 1 2 3; do
        id="$(boot_id)"
        guest "timeout 300 systemctl is-system-running --wait >/dev/null" || true
        now="$(boot_id)"
        [[ -n "$id" && "$now" == "$id" ]] && return 0
        wait_ssh "$id"   # it rebooted, e.g. setting its kernel arguments on a first boot
    done
    die "the machine keeps rebooting"
}

# Shared by the commands that work on tester inside the machine.
read -r -d '' guest_lib <<'EOF' || true
uid=$(id -u tester 2>/dev/null || true); home=$(getent passwd tester | cut -d: -f6)
as_user() { runuser -u tester -- env HOME=$home XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland "$@"; }
# tester logged out and GDM held: settings written now are what the next login reads
log_out() {
    systemctl stop gdm
    loginctl terminate-user tester 2>/dev/null || true
    for _ in $(seq 30); do pgrep -u tester -x gnome-shell >/dev/null || break; sleep 1; done
}
# dbus-daemon talks on stderr about every private bus it starts; only gsettings' own errors are kept
offline_gsettings() { runuser -u tester -- env -u XDG_RUNTIME_DIR HOME=$home dbus-run-session -- gsettings "$@" 2> >(grep -v "^dbus-daemon\[" >&2); }
enable_extension() {
    local cur
    cur=$(offline_gsettings get org.gnome.shell enabled-extensions)
    offline_gsettings set org.gnome.shell enabled-extensions "$(python3 -c '
import ast, sys
cur = ast.literal_eval(sys.argv[1].removeprefix("@as "))
print(repr(cur if sys.argv[2] in cur else cur + [sys.argv[2]]))' "$cur" "$1")"
}
log_in() {
    systemctl start gdm
    for _ in $(seq 60); do pgrep -u tester -x gnome-shell >/dev/null && break; sleep 2; done
    pgrep -u tester -x gnome-shell >/dev/null || { echo "tester has no GNOME Shell after two minutes" >&2; exit 1; }
    sleep 15
}
EOF
guest_lib+=$'\n'

# The session starts in the overview, with GNOME's welcome dialog on a first login, and
# in the overview windows draw no frames of their own: Escape twice closes both.
leave_overview() { send_keys esc esc; }

cmd_setup() {
    local image="${1:-$default_image}"
    local build="$dir/build"
    [[ ! -f "$dir/disk.qcow2" ]] || die "the machine already exists; to make it again, delete $dir first"
    [[ -f "$key" ]] || ssh-keygen -q -t ed25519 -N "" -C "borshevik-workspace-manager test machine" -f "$key"
    rm -rf "$build"
    mkdir -p "$build/store"
    cat >"$build/config.toml" <<EOF
[[customizations.user]]
name = "root"
key = "$(cat "$key.pub")"

[customizations.kernel]
append = "systemd.wants=sshd.service"

[[customizations.filesystem]]
mountpoint = "/"
minsize = "40 GiB"
EOF
    # the builder itself is not signed; the image is pulled under the host's own policy
    echo '{"default": [{"type": "insecureAcceptAnything"}]}' >"$build/policy.json"
    echo "building the machine's disk from $image; this asks for your password once and takes a while"
    # The builder's working store goes next to its output, under the invoking user's home:
    # root's own /var is where root's container storage lives, and too small for both.
    run0 sh -c "set -e
        trap \"podman rmi '$image' quay.io/centos-bootc/bootc-image-builder:latest >/dev/null 2>&1 || true
              chown -R $(id -u):$(id -g) '$build'\" EXIT
        podman pull '$image'
        podman pull --signature-policy '$build/policy.json' quay.io/centos-bootc/bootc-image-builder:latest
        podman run --rm --privileged --security-opt label=type:unconfined_t \
            -v '$build/config.toml':/config.toml:ro -v '$build':/output -v '$build/store':/store \
            -v /var/lib/containers/storage:/var/lib/containers/storage \
            quay.io/centos-bootc/bootc-image-builder:latest \
            --type qcow2 --rootfs btrfs '$image'"
    [[ -f "$build/qcow2/disk.qcow2" ]] || die "the builder produced no disk"
    mv "$build/qcow2/disk.qcow2" "$dir/disk.qcow2"
    rm -rf "$build"
    boxes cp /app/share/qemu/edk2-i386-vars.fd "$dir/vars.fd"
    echo "made the machine in $dir; start it with: $0 start${1:+ $1}"
}

cmd_start() {
    local image="${1:-$default_image}"
    [[ -f "$dir/disk.qcow2" ]] || die "no machine yet; run: $0 setup"
    running && die "the machine is already running"
    local port digest
    port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
    echo "$port" >"$dir/port"
    digest="$(skopeo inspect --format '{{.Digest}}' "docker://$image")"
    echo "starting the machine on $image ($digest)"

    # in a session of its own, so it outlives this script
    setsid flatpak run --filesystem="$dir" --command=qemu-system-x86_64 org.gnome.Boxes \
        -name "bwm-test-vm" \
        -enable-kvm -machine q35 -cpu host -smp 4 -m 6144 \
        -drive if=pflash,format=raw,readonly=on,file=/app/share/qemu/edk2-x86_64-code.fd \
        -drive "if=pflash,format=raw,file=$dir/vars.fd" \
        -drive "file=$dir/disk.qcow2,if=virtio" \
        -device virtio-vga -display none \
        -spice "unix=on,addr=$dir/spice.sock,disable-ticketing=on" \
        -qmp "unix:$dir/qmp.sock,server=on,wait=off" \
        -device qemu-xhci -device usb-tablet \
        -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:$port-:22" \
        -serial "file:$dir/serial.log" >"$dir/qemu.log" 2>&1 </dev/null &
    for _ in $(seq 20); do running && break; sleep 1; done

    wait_ssh ""
    settle
    # Borshevik's own images are signed and their policy knows the key; others are taken as they are.
    local transport="ostree-unverified-registry:" booted rebased=0
    [[ "$image" == ghcr.io/komorebinator/* ]] && transport="ostree-image-signed:docker://"
    booted="$(guest "rpm-ostree status --json" | python3 -c '
import json, sys
b = [d for d in json.load(sys.stdin)["deployments"] if d.get("booted")][0]
print(b.get("container-image-reference-digest", ""), b.get("container-image-reference", ""))')"
    if [[ "$booted" != "$digest $transport$image" ]]; then
        echo "bringing it to $image"
        guest_once "rpm-ostree rebase $transport$image" >"$dir/rebase.log" 2>&1 \
            || die "rebase failed; see $dir/rebase.log"
        rebased=1
    fi

    # tester: logged in by GDM itself, its screen never blanks or locks, so every screenshot
    # shows the desktop, and GNOME Shell's Eval answers through the helper extension
    tar -C "$repo_root/tests/vm" -cf - "$helper" | guest_once "$guest_lib"'
        set -e
        id tester >/dev/null 2>&1 || useradd -m -c Tester tester
        echo tester:bwm-test | chpasswd
        uid=$(id -u tester); home=$(getent passwd tester | cut -d: -f6)
        # on Borshevik, its App Manager would open over the desktop at a first login
        runuser -u tester -- mkdir -p "$home/.local/state/borshevik"
        runuser -u tester -- touch "$home/.local/state/borshevik/app-manager-first-run.done"
        ext=$home/.local/share/gnome-shell/extensions
        runuser -u tester -- mkdir -p "$ext"
        rm -rf "$ext/'"$helper"'"
        tar -C "$ext" -xf -
        chown -R tester:tester "$ext"
        log_out
        offline_gsettings set org.gnome.desktop.session idle-delay 0
        offline_gsettings set org.gnome.desktop.screensaver lock-enabled false
        enable_extension '"$helper"'
        conf=/etc/gdm/custom.conf
        touch "$conf"
        grep -q "^\[daemon\]" "$conf" || printf "[daemon]\n" >>"$conf"
        sed -i "/^TimedLogin/d; /^AutomaticLogin/d; /^InitialSetupEnable/d" "$conf"
        sed -i "/^\[daemon\]/a AutomaticLoginEnable=true\nAutomaticLogin=tester\nInitialSetupEnable=false" "$conf"' \
        >/dev/null
    if [[ "$rebased" -eq 1 ]]; then
        local id; id="$(boot_id)"
        guest_once systemctl reboot || true
        wait_ssh "$id"
        settle
        guest "$guest_lib"'
            for _ in $(seq 60); do pgrep -u tester -x gnome-shell >/dev/null && break; sleep 2; done
            sleep 15'
    else
        guest "$guest_lib log_in"
    fi
    leave_overview
    echo "running; $0 ssh, or look at it with:"
    echo "  flatpak run --filesystem=$dir --command=spicy org.gnome.Boxes --uri=spice+unix://$dir/spice.sock"
}

cmd_deploy() {
    need_running
    [[ -d "$repo_root/$uuid" ]] || die "no $uuid in $repo_root"
    tar -C "$repo_root" -cf - --exclude=gschemas.compiled "$uuid" | guest_once "$guest_lib"'
        set -e
        ext=$home/.local/share/gnome-shell/extensions
        runuser -u tester -- mkdir -p "$ext"
        rm -rf "$ext/'"$uuid"'"
        tar -C "$ext" -xf -
        chown -R tester:tester "$ext"
        runuser -u tester -- glib-compile-schemas "$ext/'"$uuid"'/schemas"
        log_out
        enable_extension '"$uuid"'
        enable_extension '"$helper"'
        offline_gsettings --schemadir "$ext/'"$uuid"'/schemas" \
            set org.gnome.shell.extensions.borshevik-workspace-manager debug-logging true
        log_in
        echo "deployed; GNOME Shell pid $(pgrep -u tester -x gnome-shell)"'
    leave_overview
}

cmd_android() {
    need_running
    guest "$guest_lib"'
        tool=/usr/libexec/borshevik/borshevik-waydroid
        [ -x $tool ] || { echo "Android comes with Borshevik images only; this machine has no $tool" >&2; exit 1; }
        if [ -e /var/lib/borshevik/waydroid-installed ]; then
            as_user waydroid session stop >/dev/null 2>&1 || true
            $tool upgrade || exit 1
        else
            $tool install || exit 1
        fi
        as_user setsid waydroid session start >/var/tmp/waydroid-session.log 2>&1 </dev/null &
        for i in $(seq 90); do
            [ "$(as_user timeout 10 waydroid prop get sys.boot_completed 2>/dev/null)" = 1 ] && { echo "Android is up"; exit 0; }
            sleep 3
        done
        echo "Android did not finish booting in four and a half minutes" >&2; tail -5 /var/tmp/waydroid-session.log >&2; exit 1'
}

cmd_droid() {
    need_running
    [[ $# -gt 0 ]] || usage
    # a frozen Android (Container: FROZEN) answers nothing until woken
    guest_once "timeout 10 gdbus call --system --dest id.waydro.Container --object-path /ContainerManager \
            --method id.waydro.ContainerManager.Unfreeze >/dev/null 2>&1
        timeout 60 lxc-attach -P /var/lib/waydroid/lxc -n waydroid --clear-env -v PATH=/system/bin:/system/xbin \
            -- $(printf '%q ' "$@") | tr -d '\r'"
}

shell_eval() { # javascript
    printf '%s' "$1" | guest_once "$guest_lib"'
        as_user busctl --user --json=short call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s "$(cat)"' |
        python3 -c '
import json, sys
ok, value = json.load(sys.stdin)["data"]
if value.startswith("\""): value = json.loads(value)
print(value if ok else "eval failed: " + value)
sys.exit(0 if ok else 1)'
}

cmd_eval() {
    need_running
    [[ $# -eq 1 ]] || usage
    if [[ -f "$1" ]]; then shell_eval "$(cat "$1")"; else shell_eval "$1"; fi
}

cmd_state() {
    need_running
    shell_eval '(() => {
        const wm = global.workspace_manager;
        const wins = global.display.list_all_windows().filter(w => w.window_type === 0 && !w.skip_taskbar);
        return `active=${wm.get_active_workspace_index()} workspaces=${wm.n_workspaces}${global.window_group.visible ? "" : " OVERVIEW"}\n` +
            wins.map(w => `  ${w.get_wm_class()} ws=${w.get_workspace()?.index()}` +
                (w._bwmAndroid ? " android-full" : "") + (w._bwmIgnored ? " ignored" : "") +
                (w._bwmState ? ` ${w._bwmState}` : "")).join("\n");
    })()'
}

send_keys() { # keys..., as QEMU's qcodes joined by +; super is meta_l
    local k r
    for k in "$@"; do
        r="$(qmp send-key "$(python3 -c '
import json, sys
names = {"super": "meta_l"}
print(json.dumps({"keys": [{"type": "qcode", "data": names.get(x, x)} for x in sys.argv[1].split("+")]}))' "$k")")"
        [[ "$r" == *'"return"'* ]] || die "cannot send $k: $r"
        sleep 1.5
    done
}

cmd_key() { need_running; [[ $# -gt 0 ]] || usage; send_keys "$@"; }

cmd_shot() {
    need_running
    local out="${1:-$dir/screen.png}"
    qmp screendump "{\"filename\": \"$dir/screen.ppm\"}" >/dev/null
    python3 - "$dir/screen.ppm" "$out" <<'PY'
import struct, sys, zlib
data = open(sys.argv[1], "rb").read()
fields, pos = [], 0
while len(fields) < 4:  # P6, width, height, maxval, skipping comments
    while data[pos:pos+1].isspace(): pos += 1
    if data[pos:pos+1] == b"#":
        pos = data.index(b"\n", pos); continue
    end = pos
    while not data[end:end+1].isspace(): end += 1
    fields.append(data[pos:end]); pos = end
pos += 1
w, h = int(fields[1]), int(fields[2])
rows = b"".join(b"\0" + data[pos + y*w*3: pos + (y+1)*w*3] for y in range(h))
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) \
    + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b"")
open(sys.argv[2], "wb").write(png)
PY
    rm -f "$dir/screen.ppm"
    echo "$out"
}

cmd_stop() {
    running || { echo "the machine is not running"; return 0; }
    # from inside, so the disk is left consistent; QMP quit only if that does not end it
    guest_once systemctl poweroff >/dev/null 2>&1 || true
    for _ in $(seq 60); do running || break; sleep 2; done
    running && { qmp quit >/dev/null 2>&1 || true; sleep 2; }
    rm -f "$dir/qmp.sock" "$dir/spice.sock" "$dir/port"
    echo "stopped"
}

cmd="${1:-}"; [[ $# -gt 0 ]] && shift
case "$cmd" in
    setup)   cmd_setup "$@" ;;
    start)   cmd_start "$@" ;;
    deploy)  cmd_deploy ;;
    android) cmd_android ;;
    ssh)     need_running; guest_once "$@" ;;
    droid)   cmd_droid "$@" ;;
    eval)    cmd_eval "$@" ;;
    state)   cmd_state ;;
    key)     cmd_key "$@" ;;
    shot)    cmd_shot "$@" ;;
    stop)    cmd_stop ;;
    *)       usage ;;
esac
