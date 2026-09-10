#!/usr/bin/env bash
#
# Populate the isolated test dconf database.
#
# dconf talks to the *session bus*, not just to $HOME: a plain `dconf write`
# would modify the live user settings instead of the isolated test home.
# This script therefore refuses to run unless it is inside a private
# dbus session started with HOME (and TTB_TEST_HOME) pointing at the
# throwaway test home:
#
#   env HOME=$TTB_TEST_HOME TTB_TEST_HOME=$TTB_TEST_HOME \
#       dbus-run-session -- bash dconf-setup.sh
set -eu

: "${TTB_TEST_HOME:?TTB_TEST_HOME must point to the isolated test home}"

if [ "$HOME" != "$TTB_TEST_HOME" ]; then
    echo "refusing to run: HOME ($HOME) != TTB_TEST_HOME ($TTB_TEST_HOME)" >&2
    exit 1
fi

if [ "${DBUS_SESSION_BUS_ADDRESS:-}" = "unix:path=${XDG_RUNTIME_DIR:-}/bus" ]; then
    echo "refusing to run: this is the live session bus, not a private one" >&2
    exit 1
fi

UUID='transparent-top-bar@icookie-tea.github.io'

# only our extension is enabled
dconf write /org/gnome/shell/enabled-extensions "['$UUID']"

# solid bright background (no wallpaper file needed) and the dark shell theme,
# so an opaque panel is black and a transparent one shows the background
dconf write /org/gnome/desktop/background/picture-options "'none'"
dconf write /org/gnome/desktop/background/primary-color "'#cccccc'"
dconf write /org/gnome/desktop/background/color-shading-type "'solid'"
dconf write /org/gnome/desktop/interface/color-scheme "'prefer-dark'"
dconf write /org/gnome/desktop/interface/enable-animations true

# match the settings the bugs were reported with
dconf write /com/ftpix/transparentbar/transparency 0
dconf write /com/ftpix/transparentbar/foreground-luminance-threshold 0.7
dconf write /com/ftpix/transparentbar/auto-foreground-color true
dconf write /com/ftpix/transparentbar/dark-full-screen true
dconf write /com/ftpix/transparentbar/sample-count 8
