#!/usr/bin/env bash
#
# Behaviour tests for transparent-top-bar.
#
# The tests run a *nested* GNOME Shell (gnome-shell --devkit) inside a
# toolbox container, drive it with an automation script and verify the two
# timing-sensitive behaviours that are hard to reproduce manually:
#
#   A. samples taken while the overview transition is running are discarded
#   B. the panel background transition survives stray style updates when a
#      window leaves the panel
#   C. the overview luminance is cached once the transition has finished
#
# Usage:
#   tests/run-tests.sh
#
# Environment:
#   CONTAINER   toolbox container name   (default: fedora-toolbox-44)
#   WORKDIR     scratch directory shared with the container
#                                        (default: /tmp/transparent-top-bar-tests)
#   KEEP=1      keep the scratch directory and logs after the run
#
# Requirements:
#   - a running session (the nested shell is shown in a mutter-devkit window)
#   - toolbox + a container with gnome-shell >= 49 (for --devkit), gjs, GTK4
#     and /usr/libexec/mutter-devkit
#
# WARNING: everything runs against a throwaway HOME and a private dbus
# session.  Never call dconf on the live session bus from here, see
# dconf-setup.sh.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

UUID="$(sed -n 's/^[[:space:]]*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$REPO_DIR/metadata.json" | head -n 1)"

CONTAINER="${CONTAINER:-fedora-toolbox-44}"
WORKDIR="${WORKDIR:-/tmp/transparent-top-bar-tests}"
TESTHOME="$WORKDIR/home"
EXTDIR="$TESTHOME/.local/share/gnome-shell/extensions/$UUID"

command -v toolbox >/dev/null || {
    echo "error: toolbox is not installed" >&2
    exit 1
}

echo "[run] container: $CONTAINER"
echo "[run] workdir:   $WORKDIR"

# 1. fresh isolated home with a copy of the extension
rm -rf "$WORKDIR"
mkdir -p "$EXTDIR/schemas"

for file in extension.js metadata.json prefs.js stylesheet.css; do
    cp "$REPO_DIR/$file" "$EXTDIR/$file"
done
cp "$REPO_DIR/schemas/ftpix.com.transparentbar.gschema.xml" "$EXTDIR/schemas/"
cp "$REPO_DIR/schemas/gschemas.compiled" "$EXTDIR/schemas/"

# the scripts run inside the container, so copy them to the shared workdir
for file in dconf-setup.sh harness.sh automation.js test-window.js; do
    cp "$SCRIPT_DIR/nested/$file" "$WORKDIR/$file"
done

# 2. populate the isolated dconf from a private dbus session
env HOME="$TESTHOME" TTB_TEST_HOME="$TESTHOME" \
    dbus-run-session -- bash "$WORKDIR/dconf-setup.sh"

# 3. run the nested shell in the container
set +e
toolbox run --container "$CONTAINER" -- \
    env HOME="$TESTHOME" TTB_TEST_HOME="$TESTHOME" \
    dbus-run-session -- bash "$WORKDIR/harness.sh"
status=$?
set -e

echo
echo "=== automation output ==="
grep -E "TTB-TEST" "$WORKDIR/shell.log" || true

if [ "${KEEP:-0}" = "1" ]; then
    echo
    echo "[run] logs kept in $WORKDIR"
else
    rm -rf "$WORKDIR"
fi

if [ "$status" -eq 0 ]; then
    echo "[run] OK"
else
    echo "[run] FAILED (status $status)"
fi
exit "$status"
