#!/usr/bin/env bash
#
# Runs inside the toolbox container, inside a private dbus session whose
# HOME/TTB_TEST_HOME point at the throwaway test home.  Starts a nested
# GNOME Shell (--devkit) that executes automation.js, connects a plain GTK4
# client to the nested Wayland socket and reports the test result.
set -u

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HERE/shell.log"
RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

echo "[harness] HOME=$HOME"

before=$(ls "$RUNTIME"/wayland-* 2>/dev/null | grep -v '\.lock$' || true)

gnome-shell --devkit --unsafe-mode \
    --automation-script "$HERE/automation.js" \
    >"$LOG" 2>&1 &
SHELL_PID=$!

nested=""
for _ in $(seq 1 120); do
    for sock in "$RUNTIME"/wayland-*; do
        [ -e "$sock" ] || continue
        case "$sock" in *.lock) continue ;; esac
        if ! printf '%s\n' "$before" | grep -qxF "$sock"; then
            nested="$sock"
            break
        fi
    done
    [ -n "$nested" ] && break
    kill -0 "$SHELL_PID" 2>/dev/null || break
    sleep 0.5
done

echo "[harness] nested display: ${nested:-<none>}"

WIN_PID=""
if [ -n "$nested" ]; then
    WAYLAND_DISPLAY="$(basename "$nested")" GDK_BACKEND=wayland \
        gjs -m "$HERE/test-window.js" >"$HERE/window.log" 2>&1 &
    WIN_PID=$!
fi

wait "$SHELL_PID"
status=$?
echo "[harness] gnome-shell exited with status $status"

if [ -n "$WIN_PID" ]; then
    kill "$WIN_PID" 2>/dev/null
fi

if grep -q 'TTB-TEST] SUMMARY ALL PASS' "$LOG"; then
    echo "[harness] RESULT: ALL PASS"
    exit 0
fi

echo "[harness] RESULT: FAILED"
grep -E "TTB-TEST (FAIL|SUMMARY)" "$LOG" || true
exit 1
