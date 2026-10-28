#!/usr/bin/env bash
# Installs MarkNotes Desktop (AppImage + desktop entry + icon) for the current user on Linux x86_64.
# Always installs the latest GitHub release unless a version is requested.
#
#   curl -fsSL https://raw.githubusercontent.com/MaxDac/marknotes-electron/main/scripts/install-linux.sh | bash
#   curl -fsSL .../install-linux.sh | bash -s -- --version 0.2.0
#   curl -fsSL .../install-linux.sh | bash -s -- --uninstall
#
# Options: -v, --version <X.Y.Z>  install that release (or set MARKNOTES_VERSION); default: latest
#          --uninstall            remove what this script installed
#          -h, --help             show this help
set -euo pipefail

REPO=MaxDac/marknotes-electron
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
OPT_DIR="$HOME/.local/opt/marknotes"
BIN_DIR="$HOME/.local/bin"
APPIMAGE="$OPT_DIR/MarkNotes.AppImage"
LINK="$BIN_DIR/marknotes"
ICON="$APP_DIR/icons/hicolor/512x512/apps/marknotes.png"
DESKTOP="$APP_DIR/applications/marknotes.desktop"

fail() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: install-linux.sh [--version X.Y.Z] [--uninstall]
  -v, --version <X.Y.Z>  install that release (or set MARKNOTES_VERSION); default: latest
  --uninstall            remove what this script installed
  -h, --help             show this help
EOF
}

refresh_caches() {
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APP_DIR/applications" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$APP_DIR/icons/hicolor" 2>/dev/null || true
}

uninstall() {
  rm -f "$LINK" "$ICON" "$DESKTOP" "$APPIMAGE"
  rmdir "$OPT_DIR" 2>/dev/null || true
  refresh_caches
  echo "MarkNotes removed (your notes and settings in ~/.config are untouched)."
}

latest_version() {
  # /releases/latest skips pre-releases, so ask the API for the newest release of any kind.
  local tag
  tag=$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases?per_page=1" |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$tag" ] || fail "could not determine the latest release of $REPO"
  echo "$tag"
}

install_app() {
  local version=$1 asset base expected actual
  [ "$(uname -s)" = Linux ] || fail "this installer only supports Linux"
  [ "$(uname -m)" = x86_64 ] || fail "only x86_64 builds are published (found $(uname -m))"
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"

  if [ -z "$version" ]; then
    version=$(latest_version)
  fi
  version=${version#v}
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]] || fail "invalid version '$version'"

  asset="MarkNotes-$version-linux-x86_64.AppImage"
  base="https://github.com/$REPO/releases/download/v$version"
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_DIR"' EXIT

  echo "Installing MarkNotes $version..."
  curl -fSL --progress-bar -o "$TMP_DIR/$asset" "$base/$asset" || fail "could not download $base/$asset"
  curl -fsSL -o "$TMP_DIR/SHA256SUMS" "$base/SHA256SUMS" || fail "could not download SHA256SUMS"
  expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$TMP_DIR/SHA256SUMS")
  [ -n "$expected" ] || fail "$asset is not listed in SHA256SUMS"
  actual=$(sha256sum "$TMP_DIR/$asset" | awk '{ print $1 }')
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $asset"

  curl -fsSL -o "$TMP_DIR/icon.png" "https://raw.githubusercontent.com/$REPO/v$version/build/icons/512x512.png" ||
    fail "could not download the icon"

  mkdir -p "$OPT_DIR" "$BIN_DIR" "$(dirname "$ICON")" "$(dirname "$DESKTOP")"
  chmod +x "$TMP_DIR/$asset"
  mv -f "$TMP_DIR/$asset" "$APPIMAGE"
  ln -sf "$APPIMAGE" "$LINK"
  install -m 644 "$TMP_DIR/icon.png" "$ICON"
  cat >"$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=MarkNotes
GenericName=Markdown Notes
Comment=Markdown notes with folders and multi-drive sync
Exec="$APPIMAGE" %U
Icon=marknotes
Terminal=false
Categories=Office;
Keywords=markdown;notes;notebook;sync;
StartupNotify=true
StartupWMClass=MarkNotes
EOF
  refresh_caches

  echo "MarkNotes $version installed: find it in your application menu or run 'marknotes'."
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "note: $BIN_DIR is not in your PATH." ;;
  esac
  echo "note: on Ubuntu 23.10+ the AppImage cannot start the Chromium sandbox; if it does not open, install the .deb from the release page or add --no-sandbox to the Exec line of $DESKTOP."
}

main() {
  local version=${MARKNOTES_VERSION:-} action=install_app
  while [ $# -gt 0 ]; do
    case $1 in
      -v | --version)
        [ $# -ge 2 ] || fail "$1 needs a value"
        version=$2
        shift 2
        ;;
      --version=*)
        version=${1#*=}
        shift
        ;;
      --uninstall)
        action=uninstall
        shift
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *) fail "unknown option '$1'" ;;
    esac
  done
  [ -n "${HOME:-}" ] || fail "HOME is not set"
  if [ "$action" = uninstall ]; then uninstall; else install_app "$version"; fi
}

# Everything runs from main so a truncated `curl | bash` download executes nothing.
main "$@"
