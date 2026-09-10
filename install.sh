#!/usr/bin/env bash
#
# Install / uninstall this GNOME Shell extension for the current user.
#
#   ./install.sh              copy the extension into the user's extensions dir
#   ./install.sh --dev        symlink this repository instead of copying it
#   ./install.sh --uninstall  remove the installed extension
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# UUID of the extension this repository is a fork of; it is removed / disabled
# so that both versions do not fight over the same panel classes.
LEGACY_UUID="transparent-top-bar@ftpix.com"

UUID="$(sed -n 's/^[[:space:]]*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' metadata.json | head -n 1)"
EXTENSIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
TARGET_DIR="$EXTENSIONS_DIR/$UUID"
LEGACY_DIR="$EXTENSIONS_DIR/$LEGACY_UUID"

mode="copy"      # copy | link
action="install" # install | uninstall

usage() {
    cat <<EOF
用法: ./install.sh [选项]

  --dev         以符号链接方式安装（改完代码注销重登即可，方便开发）
  --copy        复制文件安装（默认）
  --uninstall   卸载已安装的扩展
  -h, --help    显示本帮助

扩展 UUID: ${UUID:-未知}
安装目录:  $TARGET_DIR
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dev) mode="link" ;;
        --copy) mode="copy" ;;
        --uninstall) action="uninstall" ;;
        -h|--help) usage; exit 0 ;;
        *) echo "未知选项: $1" >&2; usage; exit 1 ;;
    esac
    shift
done

if [ ! -f metadata.json ]; then
    echo "错误: 请在扩展目录里运行此脚本（找不到 metadata.json）" >&2
    exit 1
fi

if [ -z "$UUID" ]; then
    echo "错误: 无法从 metadata.json 读取 uuid" >&2
    exit 1
fi

disable_extension() {
    command -v gnome-extensions >/dev/null 2>&1 || return 0
    gnome-extensions disable "$1" >/dev/null 2>&1 || true
}

# Fall back to writing the org.gnome.shell settings directly. The running
# shell only scans the extension directories at startup, so enabling a brand
# new UUID at runtime fails with "extension does not exist"; this makes sure
# it is enabled on the next login.
settings_set_enabled() {
    local uuid="$1"
    local enable="$2"

    command -v python3 >/dev/null 2>&1 || return 1

    python3 - "$uuid" "$enable" <<'PY' 2>/dev/null || return 1
import sys

try:
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio
except Exception:
    sys.exit(1)

uuid = sys.argv[1]
enable = sys.argv[2] == 'enable'
s = Gio.Settings(schema_id='org.gnome.shell')
enabled = list(s.get_strv('enabled-extensions'))
disabled = list(s.get_strv('disabled-extensions'))

if enable:
    if uuid not in enabled:
        enabled.append(uuid)
    disabled = [u for u in disabled if u != uuid]
else:
    enabled = [u for u in enabled if u != uuid]
    if uuid not in disabled:
        disabled.append(uuid)

s.set_strv('enabled-extensions', enabled)
s.set_strv('disabled-extensions', disabled)
PY
}

remove_legacy() {
    if [ ! -e "$LEGACY_DIR" ] && [ ! -L "$LEGACY_DIR" ]; then
        return 0
    fi

    disable_extension "$LEGACY_UUID"
    settings_set_enabled "$LEGACY_UUID" disable || true

    if [ "$(readlink -f "$LEGACY_DIR" 2>/dev/null || true)" = "$SCRIPT_DIR" ]; then
        rm -rf "$LEGACY_DIR"
        echo "已移除同仓库的旧 UUID 安装: $LEGACY_DIR"
    else
        echo "检测到旧 UUID 扩展 $LEGACY_UUID（已禁用，目录未删除）"
    fi
}

install_extension() {
    command -v glib-compile-schemas >/dev/null 2>&1 || {
        echo "错误: 找不到 glib-compile-schemas，请先安装 glib2" >&2
        exit 1
    }
    command -v cp >/dev/null 2>&1 || true

    remove_legacy
    glib-compile-schemas --strict schemas

    mkdir -p "$EXTENSIONS_DIR"
    rm -rf "$TARGET_DIR"

    if [ "$mode" = "link" ]; then
        ln -s "$SCRIPT_DIR" "$TARGET_DIR"
        echo "已符号链接: $TARGET_DIR -> $SCRIPT_DIR"
    else
        mkdir -p "$TARGET_DIR"
        cp -r metadata.json extension.js prefs.js stylesheet.css schemas "$TARGET_DIR/"
        glib-compile-schemas --strict "$TARGET_DIR/schemas"
        echo "已复制到: $TARGET_DIR"
    fi

    if command -v gnome-extensions >/dev/null 2>&1 && \
        gnome-extensions enable "$UUID" >/dev/null 2>&1; then
        echo "已启用: $UUID"
    elif settings_set_enabled "$UUID" enable; then
        echo "已写入用户设置，登录后自动启用: $UUID"
    else
        echo "已安装。登录后执行: gnome-extensions enable $UUID"
    fi

    cat <<EOF

提示: GNOME Shell 不支持热重载已加载的扩展代码。
  - 新 UUID 首次启用通常可以在当前会话立即生效；
  - 之后修改代码需要注销重新登录（Wayland），或用嵌套会话测试。
EOF
}

uninstall_extension() {
    disable_extension "$UUID"

    if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
        rm -rf "$TARGET_DIR"
        echo "已卸载: $TARGET_DIR"
    else
        echo "未安装: $TARGET_DIR"
    fi
}

case "$action" in
    install) install_extension ;;
    uninstall) uninstall_extension ;;
esac
