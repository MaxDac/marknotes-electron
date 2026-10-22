#!/usr/bin/env bash
# Verifies the Linux installers in release/ and launch-smokes them.
# Usage (Ubuntu, non-root user with sudo, inside an X server):
#   npm run dist -- --linux AppImage deb --publish never
#   xvfb-run -a bash scripts/linux-package-smoke.sh
# Needs: dpkg-deb, desktop-file-validate (desktop-file-utils), xdotool, xprop (x11-utils), node.
set -euo pipefail

PRODUCT=MarkNotes
EXECUTABLE=marknotes
PACKAGE=marknotes-desktop
INSTALL_DIR=/opt/$PRODUCT
RELEASE_DIR=${RELEASE_DIR:-release}
LAUNCH_TIMEOUT=${LAUNCH_TIMEOUT:-90}

fail() {
  echo "::error::$*" >&2
  exit 1
}
step() { echo "::group::$*"; }
end() { echo "::endgroup::"; }

[ "$(id -u)" != 0 ] || fail "Run as a regular user: Electron refuses to start as root without --no-sandbox."
[ -n "${DISPLAY:-}" ] || fail "DISPLAY is not set; run under xvfb-run."

version=$(node -p "require('./package.json').version")
deb="$RELEASE_DIR/$PRODUCT-$version-linux-amd64.deb"
appimage="$RELEASE_DIR/$PRODUCT-$version-linux-x86_64.AppImage"
[ -f "$deb" ] || fail "Missing $deb ($(ls "$RELEASE_DIR"))"
[ -f "$appimage" ] || fail "Missing $appimage"

step "Auto-update metadata"
meta="$RELEASE_DIR/latest-linux.yml"
cat "$meta"
grep -qx "path: $(basename "$appimage")" "$meta" || fail "latest-linux.yml path must be the AppImage"
grep -qx "  - url: $(basename "$appimage")" "$meta" || fail "latest-linux.yml files must list the AppImage"
end

step "deb control fields"
dpkg-deb -I "$deb"
field() { dpkg-deb -f "$deb" "$1"; }
[ "$(field Package)" = "$PACKAGE" ] || fail "Package is '$(field Package)', expected $PACKAGE"
[ "$(field Version)" = "$version" ] || fail "Version is '$(field Version)', expected $version"
[ "$(field Architecture)" = amd64 ] || fail "Architecture is '$(field Architecture)', expected amd64"
[[ "$(field Maintainer)" =~ ^[^\<]+\ \<[^@\>]+@[^\>]+\>$ ]] || fail "Maintainer '$(field Maintainer)' is not 'Name <email>'"
[ "$(field Section)" = editors ] || fail "Section is '$(field Section)', expected editors"
synopsis=$(field Description | head -n 1)
[ -n "${synopsis// /}" ] || fail "Description has an empty synopsis line"
end

step "deb contents"
contents=$(dpkg-deb -c "$deb")
has() { grep -qE " \./${1#/}$" <<< "$contents" || fail "deb is missing $1"; }
has "$INSTALL_DIR/$EXECUTABLE"
has "$INSTALL_DIR/chrome-sandbox"
has "$INSTALL_DIR/resources/app.asar"
has "$INSTALL_DIR/resources/apparmor-profile"
has "/usr/share/applications/$EXECUTABLE.desktop"
for size in 16 24 32 48 64 128 256 512; do
  has "/usr/share/icons/hicolor/${size}x${size}/apps/$EXECUTABLE.png"
done
grep -E " \./opt/$PRODUCT/(chrome-sandbox|$EXECUTABLE)$" <<< "$contents"
# Only the postinst may make chrome-sandbox SUID; nothing ships world-writable.
grep -E "^-r.s.* \./opt/$PRODUCT/chrome-sandbox$" <<< "$contents" && fail "chrome-sandbox must not be SUID inside the archive"
writable=$(grep -E '^.{8}w' <<< "$contents" | grep -v '^l' || true)
[ -z "$writable" ] || fail "World-writable entries in the deb: $writable"
end

step "Desktop entry"
extract=$(mktemp -d)
dpkg-deb -x "$deb" "$extract"
desktop="$extract/usr/share/applications/$EXECUTABLE.desktop"
cat "$desktop"
desktop-file-validate "$desktop"
grep -qx "Exec=$INSTALL_DIR/$EXECUTABLE %U" "$desktop" || fail "Unexpected Exec line"
grep -qx "Icon=$EXECUTABLE" "$desktop" || fail "Unexpected Icon line"
grep -qx "StartupWMClass=$EXECUTABLE" "$desktop" || fail "StartupWMClass must match desktopName ($EXECUTABLE)"
grep -qx "Name=$PRODUCT" "$desktop" || fail "Unexpected Name line"
grep -q '^Categories=Office;' "$desktop" || fail "Unexpected Categories line"
rm -rf "$extract"
end

# Starts the app, waits for its visible window and checks WM_CLASS and the rendered UI, then quits it.
smoke() {
  local label=$1
  shift
  local user_data log port pid deadline wid
  user_data=$(mktemp -d)
  log=$(mktemp)
  port=$((9300 + RANDOM % 500))
  MARKNOTES_USER_DATA="$user_data" "$@" --remote-debugging-port="$port" > "$log" 2>&1 &
  pid=$!
  deadline=$((SECONDS + LAUNCH_TIMEOUT))
  wid=""
  while [ -z "$wid" ]; do
    if ! kill -0 "$pid" 2> /dev/null; then
      cat "$log"
      fail "$label exited before showing a window"
    fi
    if ((SECONDS > deadline)); then
      cat "$log"
      kill "$pid" || true
      fail "$label did not show a window within ${LAUNCH_TIMEOUT}s"
    fi
    # The window is only shown on ready-to-show, i.e. after the renderer painted.
    wid=$(xdotool search --onlyvisible --classname "$EXECUTABLE" 2> /dev/null | head -n 1 || true)
    [ -n "$wid" ] || sleep 1
  done
  local wm_class
  wm_class=$(xprop -id "$wid" WM_CLASS)
  echo "$label window $wid: $wm_class, title: $(xdotool getwindowname "$wid")"
  [[ "$wm_class" == *"\"$EXECUTABLE\""* ]] || fail "$label WM_CLASS does not match StartupWMClass=$EXECUTABLE"
  # shellcheck disable=SC2016 # JavaScript template literals, not shell expansions.
  PORT=$port node --input-type=module -e '
    const base = `http://127.0.0.1:${process.env.PORT}`;
    const pages = await (await fetch(`${base}/json/list`)).json();
    const page = pages.find((p) => p.type === "page" && p.url.endsWith("/renderer/index.html"));
    if (!page) throw new Error(`renderer page not found: ${JSON.stringify(pages)}`);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const expression = "[...document.querySelectorAll(\"h1,h2,h3\")].map((e) => e.textContent.trim())";
    let headings = [];
    for (let i = 0; i < 30 && !headings.includes("MarkNotes"); i++) {
      if (i) await new Promise((r) => setTimeout(r, 1000));
      ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
      headings = await new Promise((resolve) => {
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === i) resolve(d.result?.result?.value ?? []); };
      });
    }
    ws.close();
    console.log(`title: ${page.title}, headings: ${JSON.stringify(headings)}`);
    if (page.title !== "MarkNotes" || !headings.includes("MarkNotes")) throw new Error("MarkNotes UI did not render");
  ' || {
    cat "$log"
    kill "$pid" || true
    fail "$label renderer check failed"
  }
  kill "$pid"
  wait "$pid" || true
  if grep -E 'FATAL|sandbox.*(not configured|failed)|Segmentation fault' "$log"; then
    fail "$label logged a fatal/sandbox error"
  fi
  rm -rf "$user_data" "$log"
  echo "$label started successfully"
}

echo "kernel.apparmor_restrict_unprivileged_userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2> /dev/null || echo n/a)"

step "Install the deb"
sudo apt-get install -y --no-install-recommends "./$deb"
dpkg -s "$PACKAGE" | grep -E '^(Status|Version):'
[ "$(readlink -f "/usr/bin/$EXECUTABLE")" = "$INSTALL_DIR/$EXECUTABLE" ] || fail "/usr/bin/$EXECUTABLE does not point to $INSTALL_DIR/$EXECUTABLE"
sandbox_mode=$(stat -c '%a %U:%G' "$INSTALL_DIR/chrome-sandbox")
echo "chrome-sandbox: $sandbox_mode"
case "$sandbox_mode" in
  "4755 root:root") ;; # SUID sandbox: kernels without unprivileged user namespaces.
  "755 root:root")
    # User-namespace sandbox; Ubuntu 24.04+ needs the bundled AppArmor profile for it.
    if sudo aa-status --enabled 2> /dev/null; then
      [ -f "/etc/apparmor.d/$EXECUTABLE" ] || fail "AppArmor is enabled but /etc/apparmor.d/$EXECUTABLE was not installed"
      sudo aa-status | grep -qE "^[[:space:]]+$EXECUTABLE\$" || fail "AppArmor profile $EXECUTABLE is not loaded"
    fi
    ;;
  *) fail "Unexpected chrome-sandbox mode $sandbox_mode" ;;
esac
end

step "Launch the installed deb (Chromium sandbox enabled)"
smoke "deb" "/usr/bin/$EXECUTABLE"
end

step "Remove the deb"
sudo apt-get remove -y "$PACKAGE"
[ ! -e "/usr/bin/$EXECUTABLE" ] || fail "/usr/bin/$EXECUTABLE left behind"
[ ! -e "/etc/apparmor.d/$EXECUTABLE" ] || fail "AppArmor profile left behind"
end

step "Extract and launch the AppImage"
work=$(mktemp -d)
cp "$appimage" "$work/app.AppImage"
(cd "$work" && ./app.AppImage --appimage-extract > /dev/null)
[ -x "$work/squashfs-root/AppRun" ] || fail "AppImage has no AppRun"
[ -f "$work/squashfs-root/$EXECUTABLE.desktop" ] || fail "AppImage is missing $EXECUTABLE.desktop"
grep -qx "StartupWMClass=$EXECUTABLE" "$work/squashfs-root/$EXECUTABLE.desktop" || fail "AppImage StartupWMClass mismatch"
# An AppImage has no AppArmor profile, so Ubuntu 23.10+ blocks its user-namespace sandbox. Smoke it with the
# sandbox where the kernel allows it (as on most other distributions); see README for the Ubuntu workaround.
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2> /dev/null || echo 0)" = 1 ]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  trap 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1' EXIT
fi
smoke "AppImage" "$work/squashfs-root/AppRun"
rm -rf "$work"
end
