#!/usr/bin/env bash
# Takes about three minutes: it waits for two real scheduled times.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

bus_config() {
    cat <<XML
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=$1</listen>
  $2
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
XML
}

if [[ "${1:-}" != --inside ]]; then
    work=$(mktemp -d "${TMPDIR:-/tmp}/shell-check-XXXXXX")
    trap 'rm -rf "$work"' EXIT
    mkdir -m 700 "$work/run" "$work/home" "$work/services"
    # Only dconf may start on the session bus: the desktop's other services would mount FUSE file systems
    # under the runtime directory and outlive the run.
    cp /usr/share/dbus-1/services/ca.desrt.dconf.service "$work/services/"
    bus_config "$work/run/bus" "<servicedir>$work/services</servicedir>" > "$work/session.conf"
    bus_config "$work/system-bus" "" > "$work/system.conf"
    status=0
    env -i \
        HOME="$work/home" \
        XDG_RUNTIME_DIR="$work/run" \
        PATH="$repo/tests/fake-bin:/usr/local/bin:/usr/bin:/bin" \
        LANG=C.UTF-8 \
        dbus-run-session --config-file="$work/session.conf" -- bash "${BASH_SOURCE[0]}" --inside "$work" || status=$?
    exit "$status"
fi

work=$2
export XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share XDG_CACHE_HOME=$HOME/.cache
export FAKE_DDCUTIL_LOG=$work/ddcutil.log
: > "$FAKE_DDCUTIL_LOG"

UUID=monitor-brightness-presets@maksforge.com
SCHEMA=org.gnome.shell.extensions.monitor-brightness-presets
extensions=$XDG_DATA_HOME/gnome-shell/extensions
mkdir -p "$extensions/shell-check@tests"
cp -r "$repo/extension" "$extensions/$UUID"

# The shell only answers Eval in unsafe mode, and Eval code cannot import modules, so a helper extension
# turns unsafe mode on and hands over the modules the checks need.
cat > "$extensions/shell-check@tests/metadata.json" <<'JSON'
{"uuid": "shell-check@tests", "name": "Shell check", "description": "Test helper", "shell-version": ["50"]}
JSON
cat > "$extensions/shell-check@tests/extension.js" <<'JS'
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class ShellCheck extends Extension {
    enable() {
        global.context.unsafe_mode = true;
        globalThis.checkMain = Main;
        globalThis.checkLogin = LoginManager;
    }

    disable() {}
}
JS

# A private stand-in for the system bus, so the shell never talks to the real logind, accounts or power services.
system_bus=$work/system-bus
dbus-daemon --config-file="$work/system.conf" --nofork --nopidfile > /dev/null 2>&1 &
bus_pid=$!
export DBUS_SYSTEM_BUS_ADDRESS="unix:path=$system_bus"
for _ in $(seq 50); do [[ -S $system_bus ]] && break; sleep 0.1; done

shell_pid=
cleanup() {
    [[ -n $shell_pid ]] && kill "$shell_pid" 2> /dev/null && wait "$shell_pid" 2> /dev/null
    kill "$bus_pid" 2> /dev/null || true
}
trap cleanup EXIT

failures=0
say() { echo "[$(date +%T)] $*"; }
fail() { failures=$((failures + 1)); say "FAIL $*"; }
expect() {
    if [[ "$2" == "$3" ]]; then say "ok   $1"; else fail "$1: expected '$3', got '$2'"; fi
}

gs() { gsettings --schemadir "$extensions/$UUID/schemas" "$@"; }
ev() {
    local out
    out=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>&1) || { echo "eval failed: $out"; return; }
    out=${out#\(true, \'}
    out=${out%\')}
    out=${out#\"}
    echo "${out%\"}"
}
until_true() {
    local what=$1 expr=$2 tries=$3
    for _ in $(seq "$tries"); do
        [[ $(ev "$expr") == true ]] && return 0
        sleep 1
    done
    fail "timed out waiting for $what"
    return 1
}
writes() { grep setvcp "$FAKE_DDCUTIL_LOG" | sort | paste -sd ';' || true; }
clear_writes() { : > "$FAKE_DDCUTIL_LOG"; }
hhmm() { date -d "@$1" +%H:%M; }
minutes() { echo $((10#$(date -d "@$1" +%H) * 60 + 10#$(date -d "@$1" +%M))); }
handled() { gs get "$SCHEMA" schedule-handled | sed 's/^int64 //'; }

TILE="checkMain.extensionManager.lookup('$UUID')?.stateObj?._indicator?.quickSettingsItems[0]"
DAY='--bus 4 setvcp 10 100;--bus 6 setvcp 10 50'
EVENING='--bus 4 setvcp 10 60;--bus 6 setvcp 10 30'
NIGHT='--bus 4 setvcp 10 25;--bus 6 setvcp 10 13'

set_extension() {
    local method=$1 want=$2
    ev "checkMain.extensionManager.$method('$UUID')" > /dev/null
    until_true "the extension to be $want" "String(Boolean($TILE)) === '$([[ $want == on ]] && echo true || echo false)'" 20
}

start=$(date +%s)
t0=$(((start - 3600) / 60 * 60))
later=$((t0 + 2 * 3600))
yesterday=$((t0 - 86400))

gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell disable-extension-version-validation true
gsettings set org.gnome.shell enabled-extensions "['shell-check@tests', '$UUID']"
gs set "$SCHEMA" schedule "[($(minutes "$t0"), 'Day'), ($(minutes "$later"), 'Night')]"
gs set "$SCHEMA" schedule-enabled true
gs set "$SCHEMA" schedule-handled "$t0"
gs set "$SCHEMA" active-preset 'Day'

gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 --wayland-display=shell-check \
    > "$work/shell.log" 2>&1 &
shell_pid=$!
if ! until_true "the shell and the extension" "String(typeof checkMain === 'object' && Boolean($TILE))" 120; then
    tail -50 "$work/shell.log"
    exit 1
fi
sleep 2

say "on start, with the current time already handled"
expect "no catch-up" "$(writes)" ""
expect "tile header shows the next change" "$(ev "$TILE.menu._headerSubtitle.text")" "Next: Night at $(hhmm "$later")"
expect "Follow schedule switch shown and on" "$(ev "JSON.stringify([$TILE._scheduleSwitch.visible, $TILE._scheduleSwitch.state])")" "[true,true]"
expect "tile subtitle" "$(ev "$TILE.subtitle")" "Day"

say "catch-up on enable applies only when a newer time passed"
set_extension disableExtension off
gs set "$SCHEMA" schedule-handled "$yesterday"
gs set "$SCHEMA" active-preset ''
clear_writes
set_extension enableExtension on
sleep 3
expect "catch-up writes the current preset" "$(writes)" "$DAY"
expect "catch-up marks the time handled" "$(handled)" "$t0"
expect "catch-up sets the active preset" "$(gs get "$SCHEMA" active-preset)" "'Day'"
set_extension disableExtension off
clear_writes
set_extension enableExtension on
sleep 3
expect "no second catch-up for the same time" "$(writes)" ""

say "a hand pick marks the current time handled"
gs set "$SCHEMA" schedule-handled "$yesterday"
clear_writes
ev "$TILE._presetSection._getMenuItems()[1].emit('activate', null)" > /dev/null
sleep 3
expect "hand pick writes its preset" "$(writes)" "$EVENING"
expect "hand pick marks the time handled" "$(handled)" "$t0"
set_extension disableExtension off
clear_writes
set_extension enableExtension on
sleep 3
expect "no catch-up over a hand pick" "$(writes)" ""
expect "hand pick kept" "$(gs get "$SCHEMA" active-preset)" "'Evening'"

say "waking from sleep catches up after the settle delay"
gs set "$SCHEMA" schedule-handled "$yesterday"
clear_writes
ev "checkLogin.getLoginManager().emit('prepare-for-sleep', false)" > /dev/null
sleep 1
expect "nothing while monitors settle" "$(writes)" ""
sleep 4
expect "catch-up after waking" "$(writes)" "$DAY"
expect "waking marks the time handled" "$(handled)" "$t0"

say "turning the schedule switch on applies the current preset at once"
gs set "$SCHEMA" schedule-enabled false
sleep 1
expect "tile header without a schedule" "$(ev "$TILE.menu._headerSubtitle.text")" "Sets every monitor at once"
expect "switch shown and off" "$(ev "JSON.stringify([$TILE._scheduleSwitch.visible, $TILE._scheduleSwitch.state])")" "[true,false]"
gs set "$SCHEMA" active-preset 'Night'
clear_writes
ev "$TILE._scheduleSwitch.toggle()" > /dev/null
sleep 3
expect "switch turns the schedule on" "$(gs get "$SCHEMA" schedule-enabled)" "true"
expect "switch applies the current preset" "$(writes)" "$DAY"
expect "switch sets the active preset" "$(gs get "$SCHEMA" active-preset)" "'Day'"

now=$(date +%s)
t1=$(((now + 30) / 60 * 60 + 60))
t2=$((t1 + 60))
say "editing the schedule re-arms the timer: Night at $(hhmm "$t1"), Evening at $(hhmm "$t2")"
gs set "$SCHEMA" schedule "[($(minutes "$t0"), 'Day'), ($(minutes "$t1"), 'Night'), ($(minutes "$t2"), 'Evening')]"
sleep 1
expect "edit keeps the current time handled" "$(handled)" "$t0"
expect "tile header shows the edited next change" "$(ev "$TILE.menu._headerSubtitle.text")" "Next: Night at $(hhmm "$t1")"
clear_writes
while (($(date +%s) < t1 + 4)); do sleep 1; done
expect "timer writes the preset at its time" "$(writes)" "$NIGHT"
expect "timer marks the time handled" "$(handled)" "$t1"
expect "timer sets the active preset" "$(gs get "$SCHEMA" active-preset)" "'Night'"
expect "tile header moves to the following change" "$(ev "$TILE.menu._headerSubtitle.text")" "Next: Evening at $(hhmm "$t2")"
clear_writes
while (($(date +%s) < t2 + 4)); do sleep 1; done
expect "re-armed timer fires again" "$(writes)" "$EVENING"
expect "re-armed timer marks its time handled" "$(handled)" "$t2"

say "an empty schedule that is off hides the switch"
gs set "$SCHEMA" schedule-enabled false
gs set "$SCHEMA" schedule '@a(is) []'
sleep 1
expect "switch hidden" "$(ev "String($TILE._scheduleSwitch.visible)")" "false"

errors=$(grep -E 'JS ERROR|monitor-brightness-presets' "$work/shell.log" || true)
expect "no extension errors in the shell log" "$errors" ""

if ((failures > 0)); then
    say "$failures check(s) failed; shell log tail:"
    tail -40 "$work/shell.log"
    exit 1
fi
say "all shell checks passed"
