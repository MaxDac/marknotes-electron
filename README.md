# MarkNotes Desktop

Desktop (Electron) markdown notes app with folders and sync to Proton Drive (unofficial), Dropbox and OneDrive.
It is the desktop sibling of the Android app [MaxDac/MarkNotes](https://github.com/MaxDac/MarkNotes) and has the same features
and the same sync format, so all MarkNotes apps can share one drive folder.

> **This is a third-party application not officially supported by Proton.**
> MarkNotes is a personal, non-commercial project. It is not affiliated with or endorsed by Proton AG,
> and it does not use any Proton logos or branding.

## Features (parity with Android)

- **Offline-first notes** stored in IndexedDB in the renderer, as a tree of folders and `.md` notes. You can create, open,
  rename, delete and move notes and folders, and a sidebar shows the whole folder tree.
- **Editor**: raw markdown (CodeMirror 6) with a preview toggle (markdown-it: tables, strikethrough, task lists,
  highlighted code blocks). It has a formatting toolbar, continues lists, checkboxes and quotes on Enter, and autosaves (debounced, and flushed when you leave the note).
- **Note links**: every note has a stable id in a hidden front-matter header. Type `@` to open a popup listing all
  notes (title, full path and id with a copy button), filter by title, path or id, and insert a
  `[Title](marknotes:<id>)` link. Clicking a link in the preview opens the note; links to missing notes are marked broken.
- **Images**: insert PNG, JPEG, GIF or WebP images from the toolbar, by pasting or by drag-and-drop. Images are
  downscaled to 2048 px, stored once in the root `attachments/` folder (named by their SHA-256) and synced to every
  drive. **Settings → Clean unused images** deletes images no note references.
- **Chord sequences** for guitar and bass (ported from ChordBuilder): **New chord sequence** creates a note with
  `type: chords` in its front-matter, marked 🎸 in the note list. It opens in a chord editor: build each chord on a
  fretboard (mute, open or a fret from 1 to 24 with fingers 1–4 per string; bass shows frets 9–24 with a red line at the
  12th), add a name, tags and a note, then edit, duplicate, reorder or delete chords in the sequence. Chords with the
  same name and instrument are numbered (`1 C`, `2 C`). The file stays readable markdown (see the spec's
  "Chord sequences"); **View as text** opens it in the markdown editor, which is also used, with the error line, when
  the file cannot be parsed. Chord sequences are opt-in: turn on **Settings → Chord sequences** (off by default, stored
  on this device only) to show **New chord sequence**. While it is off, opening a chord sequence asks whether to turn
  it on; **Enable** turns it on and opens the note, **Cancel** leaves the note closed.
- **Appearance**: theme System, Light or Dark, and an accent colour from 8 palettes.
- **Multi-drive two-way sync** with any number of Proton Drive, Dropbox and OneDrive accounts. Sync runs on launch and
  on **Sync now** (no background polling). It keeps per-drive state and the `.marknotes/manifest.json` manifest, and merges lines
  three-way against the last synced version. When edits overlap, the newest version wins and the other one is saved next
  to the note as `<name> (conflicted copy).md` (with a new note id) on every drive. The conflicts page merges the copy
  back (per change: Kept, Copy, Both, Neither, or edit by hand), discards it or keeps both files.
  Images are binary and immutable: they are uploaded, downloaded and deleted, never merged.
  The sync algorithm (plan, merge, conflicts, manifest, multi-drive order) comes from the shared Rust core
  [marknotes-sync](https://github.com/MaxDac/marknotes-sync) (`@marknotes/sync`, WebAssembly), used by every MarkNotes
  app; this app only does the file and drive I/O.
  New notes, conflicted copies and folders use create-only writes: a concurrent creation is never overwritten or
  adopted. Conflicted copies keep the losing edit's modification time and have a durable, encrypted retry intent,
  so restarting an interrupted sync reuses the verified copy and its generated note id.
  Folder deletion removes known files conditionally and folders only when atomically empty. The current cloud
  adapters cannot guarantee atomic empty-only folder removal, so they report a step error and retain the folder
  and its sync state instead of risking unseen notes. Record-backed case-only renames converge locally when the
  stale content is unchanged. OneDrive supports conditional, no-clobber remote case-only moves; Dropbox and Proton
  report an unsupported-step error without changing the drive.
- **Proton login**: SRP password login with TOTP. CAPTCHA/human verification, two-password mode and FIDO2-only
  accounts are not supported.
- **Dropbox / OneDrive login**: OAuth 2 PKCE (Dropbox) and MSAL (OneDrive) in the system browser, with a loopback redirect.
- Tokens are encrypted with Electron `safeStorage` (OS keychain). See [Security and privacy](#security-and-privacy).

The file format shared with the Android and web apps is specified in [marknotes-spec](https://github.com/MaxDac/marknotes-spec)
(`spec/` submodule, [spec/note-format.md](spec/note-format.md)); its golden fixtures run against this app in CI.
See [AGENTS.md](AGENTS.md) for the cross-app parity rules.

Out of scope: search, tags, background sync, local encryption.

## Security and privacy

- **Drive credentials** (OAuth tokens, the Proton session and the key passphrase that decrypts the drive) are kept in
  `credentials.bin` in the profile folder, encrypted with Electron `safeStorage`: the macOS Keychain, Windows DPAPI or
  the Linux Secret Service/KWallet. The Proton password is only used to sign in and is never stored; a sign-in waiting
  for its two-factor code is dropped after 10 minutes or when you leave the form.
- **Linux without a keyring**: Chromium falls back to a hardcoded key (`basic_text`), which does not protect anything.
  In that case credentials are only kept in memory (you sign in again after each launch), any older
  `credentials.bin` is deleted, and Settings and Add drive show a warning.
- **Notes on this device** are stored in the app's IndexedDB in the profile folder, encrypted: every note, image,
  sync record, base copy and setting is encrypted with AES-256-GCM, and paths and drive ids are replaced by keyed
  hashes (HMAC-SHA-256). The data key is a random key in `localkey.bin`, protected by the OS keychain (`safeStorage`).
  The unencrypted database of earlier versions is migrated and deleted on first start. **Linux without a keyring**
  (see above): nothing can protect the key, so it is stored as is and Settings recommends the app lock.
- **App lock** (Settings → Privacy): the data key is wrapped with a key derived from a passphrase (scrypt), so the
  notes can't be read without it. MarkNotes then asks for the passphrase on start, after an idle time (off, 5, 15 or
  60 minutes), when the computer sleeps and when the screen locks; locking forgets the key and reloads the window.
  Wrong passphrases get a generic error after a delay. **There is no recovery**: if you forget the passphrase, delete
  the local data from the lock screen and connect a drive again to download the notes (notes never synced are lost).
- **Settings → Delete all local data** disconnects every drive, deletes the local notes, images and sync state
  (nothing is deleted from the drives) and replaces the data key. When disconnecting the last drive you can also
  delete the local notes. Deleted IndexedDB data and the old unencrypted database may stay in the LevelDB files on
  disk until they are compacted; they are not securely erased, but encrypted records can no longer be decrypted once
  the key is replaced.
- **Remote images** in notes are not loaded: a note could otherwise reveal when and where it is read. Only `https:`
  images can be loaded, per note and for the current session, with **Load remote images**; other sources (`http:`,
  `//host`, `file:`, network paths) are never loaded.
- **Hardening**: sandboxed, context-isolated renderer with a strict CSP; IPC calls are only served to the app page;
  every web permission except clipboard writes is denied; packaged builds ignore the test and dev server switches
  and ship with Electron fuses (no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or `--inspect`, app loaded only from an
  integrity-checked `app.asar`, encrypted cookies).
- **Releases** are only code signed when signing secrets are configured; unsigned releases are flagged in the release
  workflow. Check downloads against `SHA256SUMS`.

## Development

Requirements: Node.js (version in `.node-version`), Git (used to apply the pinned build-dependency patch), Rust
1.99.1 with the `wasm32-unknown-unknown` target, a C/C++ linker for Rust host build scripts, and wasm-bindgen CLI
0.2.129. The source-pinned shared sync dependency
builds WebAssembly during `npm ci`; no unpublished release artifact is required.
Clone with `git clone --recurse-submodules`, or run `git submodule update --init` in an existing clone, to fetch `spec/`.

```sh
rustup toolchain install 1.99.1 --profile minimal --component rustfmt,clippy --target wasm32-unknown-unknown
cargo +1.99.1 install wasm-bindgen-cli --version 0.2.129 --locked
npm ci
npm run deps:check     # no deprecated packages anywhere in the lockfile
npm run deps:audit     # zero known vulnerabilities, including dev/optional/peer dependencies
npm run dev            # start the app with hot reload
npm run lint           # eslint
npm run format:check   # prettier
npm run typecheck      # tsc
npm test               # vitest unit tests
npm run test:parity    # marknotes-spec golden fixtures (needs the spec/ submodule)
npm run build          # production bundles (electron-vite)
npm run preview        # build and open the production app in Electron
npm run e2e            # Playwright Electron E2E (run `npm run build` first)
npm run dist           # installers via electron-builder, written to release/
```

`npm ci` applies the pinned dependency patch and installs the Electron runtime using the installed Electron
package's official installer. Both steps are safe to repeat, and installation failures stop setup.
Production-only installs (`npm ci --omit=dev`) skip the development runtime; use `npm ci --include=dev`
to restore development tools.

Both `dev` and `preview` open a desktop Electron window, not a browser preview server. Preview builds all bundles
by default; `npm run preview -- --skipBuild` opens an existing build. If an older installation reports
`Electron uninstall` or a missing Electron executable, run `npm exec -- install-electron` to download the pinned
runtime, then retry preview. If `electron-vite` itself is missing, run `npm ci --include=dev` first.
On headless Linux, launch Electron tests under Xvfb as described in [AGENTS.md](AGENTS.md).

The `@electron/get` 3.x override uses `global-agent` 4 to avoid its deprecated `boolean` dependency
and the vulnerable `roarr` / `sprintf-js` chain while retaining the proxy bootstrap API.
Keep Vite 7 / React plugin 5 and TypeScript 6 until electron-vite and typescript-eslint support newer majors.

### Dependency policy

The complete lockfile must contain no deprecated packages and the full npm audit must report zero known
vulnerabilities at every severity. Development, optional, peer and platform-specific packages are included.
Audit/network errors fail the check; advisories are not ignored. This establishes the absence of **known npm
advisories at check time**, not a guarantee against undiscovered vulnerabilities or vendor advisories outside npm's data.
The deprecation check reads lockfile metadata; recheck registry metadata when updating dependencies, because a package
can be deprecated after the lockfile was generated.

Every package resolves from `https://registry.npmjs.org/` except the shared sync core `@marknotes/sync`, built from an
immutable [marknotes-sync](https://github.com/MaxDac/marknotes-sync) source commit by its `prepare` script. Its exact
Git commit is pinned in `package.json` and the lockfile; the core pins Rust and Cargo dependencies. Keep both Git
URLs on HTTPS, not SSH, so fresh installs need no SSH credentials. Updating the dependency also
requires keeping `.github/actions/setup-sync-core/action.yml` and the prerequisites above aligned with the core's
`rust-toolchain.toml` and wasm-bindgen version. Regenerate only the lockfile with
`npm install --package-lock-only --ignore-scripts`, then verify a fresh `npm ci` with the required toolchains.

Stable electron-builder 26.18.0 and electron-updater 6.8.11 still need these version-pinned compatibility fixes:

- ASAR 4.3.1 replaces ASAR 3 beneath app-builder-lib, its universal helper and electron-winstaller, removing
  `glob` 7 and `inflight`. Tests cover builder stream packaging, installer extraction, universal archive merging,
  unpacked files and header integrity on Node 24. The macOS universal-merger test runs on macOS/Linux,
  not Windows; installer extraction and temporary-file cleanup are tested on all three platforms.
- electron-updater's `lodash.isequal` import resolves to `fast-deep-equal` 3.1.3 through an npm alias, replacing
  the deprecated implementation. Its only call sites compare downloaded update metadata; tests cover nested
  equality, changed metadata, missing files and persisted-cache SHA-512 verification.
- `temp` 0.9.4 uses rimraf 6.1.3 instead of rimraf 2. The tracked `patches/temp+0.9.4.patch` adapts its imports,
  retry options and promise-to-callback handling. `npm ci` applies it using Git through `postinstall`, failing if
  the patch no longer applies; repeat runs are idempotent. Runtime-only installs omit this build-only patch.
  Tests cover synchronous, promise and callback cleanup.

Remove each override/patch when a stable parent release eliminates the corresponding deprecated dependency and
passes compatibility tests. Keep builder/updater pinned until those fixes have been re-evaluated. Do not use
blanket major overrides or suppress installation warnings. Regenerate only the lockfile with
`npm install --package-lock-only --ignore-scripts`, then use `npm ci` to perform a real patched installation.

Dropbox and OneDrive use the built-in public OAuth registrations shared with Android, so both are available
in local development and packaged builds without extra configuration. These identifiers are not client secrets;
sign-in still requires the user's consent and the desktop redirect registrations described below.
To use different registrations, set `DROPBOX_APP_KEY` and `MSAL_CLIENT_ID` as environment variables.
Runtime environment values take precedence over build-time values; release builds read optional build-time overrides
from the repository secrets (see below), then fall back to the built-in IDs. Blank values also use the defaults.
Proton Drive needs no keys.

## CI/CD

- `checks.yml` (reusable) checks dependencies (deprecations and a full all-severity audit), lint/format/types,
  unit tests, the marknotes-spec parity fixtures ("Parity (marknotes-spec fixtures)"), Electron E2E, Linux AppImage/deb
  packaging, and unsigned Windows NSIS/macOS dmg/zip packaging (both macOS architectures). PR, main and release
  workflows all inherit these checks; release packaging waits for them.
- "Build (linux)" runs `scripts/linux-package-smoke.sh`: it checks the deb metadata (maintainer, package name,
  desktop entry, icons, `chrome-sandbox` permissions) and `latest-linux.yml`, installs the deb and launches it under
  Xvfb with the Chromium sandbox, removes it, then extracts the AppImage and launches it too.
- `pr-ci.yml` also runs "Dependency review" (fails on new dependencies with high or critical advisories, as in the
  Android and web repos) and "Lint workflows (actionlint)".
- `codeql.yml` runs CodeQL ("CodeQL (javascript-typescript)", "CodeQL (actions)") on pull requests, on `main` and weekly.
- `dependabot-automerge.yml` enables squash auto-merge on Dependabot patch and minor updates. Major updates and the
  `electron` group always need a manual review. It needs **Allow auto-merge** in the repository settings and only merges
  once the required checks pass.

## Release

`release.yml` publishes the desktop installers as a GitHub Release.

### Cutting a release

1. Make sure `main` is green.
2. Go to Actions → Release → Run workflow, enter the `version` (`X.Y.Z`, tagged `vX.Y.Z`) and choose `prerelease`.
3. The workflow validates the version, runs the checks, builds the installers on Linux (AppImage, deb), Windows (NSIS)
   and macOS (dmg and zip, for both Apple silicon `arm64` and Intel `x64`), and creates the `vX.Y.Z` release from the
   workflow commit. Release assets: the installers, the auto-update metadata (`latest.yml`, `latest-mac.yml`,
   `latest-linux.yml`), the `*.blockmap` files for differential downloads, and `SHA256SUMS`. The workflow summary
   lists the version, pre-release flag, signing status and every asset with its SHA-256.

`package.json` is not bumped in git; the workflow sets the version only for the build.

### Linux packages

Linux builds are x64 only: `MarkNotes-X.Y.Z-linux-x86_64.AppImage` and `MarkNotes-X.Y.Z-linux-amd64.deb`.

- The deb (package `marknotes-desktop`) installs to `/opt/MarkNotes`, adds the `marknotes` command and a desktop entry,
  and installs an AppArmor profile so the Chromium sandbox works on Ubuntu 24.04. It does not update itself.
- The AppImage updates itself (`latest-linux.yml` points to it). Ubuntu 23.10 and later restrict unprivileged user
  namespaces, so the AppImage cannot start the Chromium sandbox there: install the deb instead, or start the AppImage
  with `--no-sandbox`.

### Repository secrets

| Secret                                                     | Purpose                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `DROPBOX_APP_KEY`                                          | Optional override of the built-in public Dropbox app key (PKCE, no client secret). |
| `MSAL_CLIENT_ID`                                           | Optional override of the built-in public Microsoft Entra application (client) ID.  |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                             | Optional code-signing certificate (base64 p12) and password.                       |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Optional macOS notarization.                                                       |

Without the signing secrets the installers are unsigned: Windows SmartScreen and macOS Gatekeeper warn on first launch.
The release workflow unsets an empty `CSC_LINK` so macOS packaging does not treat it as a certificate file path.

### Auto-update

Packaged apps use [electron-updater](https://www.electron.build/auto-update) with the GitHub Releases of this repository.
On startup the app checks for a newer release once, downloads it in the background, and shows a
**Restart to update** banner when it is ready. If you choose **Later**, the update is installed when you quit the app.
Development, E2E and unpackaged runs never check for updates.

- Stable builds only see stable releases. Builds published with `prerelease` (or with a pre-release version) also
  receive pre-releases.
- Windows (NSIS) and Linux AppImage builds update themselves.
- The Linux `.deb` package cannot update itself; install new versions from the Releases page.
- **macOS only installs updates for signed and notarized builds** (Squirrel.Mac checks the code signature). Until the
  `CSC_LINK`/`APPLE_*` secrets are set, macOS users must download new versions manually; the failed update is ignored.

### Rollback

A bad release can be withdrawn without a new build:

1. Delete the release and its tag: `gh release delete vX.Y.Z --cleanup-tag --yes`.
2. If the previous release is not marked as latest, mark it: `gh release edit vX.Y.W --latest`
   (stable clients follow the release marked **Latest**).
3. Clients that already updated keep the bad version, as updates never downgrade. Publish a fixed `X.Y.(Z+1)` to move
   them forward.

### Provider registrations

The desktop app reuses the Dropbox and Entra apps of the Android app. The full guide is in
[MarkNotes `docs/cloud-providers.md`](https://github.com/MaxDac/MarkNotes/blob/main/docs/cloud-providers.md)
(section 5 for desktop, section 6 for Proton Drive).

- **Dropbox**: create an app in the [Dropbox App Console](https://www.dropbox.com/developers/apps) with "Full Dropbox"
  access and the scopes `account_info.read`, `files.metadata.read`, `files.content.read`, `files.content.write`.
  Add the loopback redirect URI `http://127.0.0.1/oauth/dropbox` (Dropbox ignores the port for loopback URIs).
- **OneDrive**: register an app in [Microsoft Entra](https://entra.microsoft.com) for personal and organizational
  accounts, with the delegated permissions `Files.ReadWrite` and `User.Read`. Add a **Mobile and desktop applications**
  platform with the redirect URI `http://localhost` (MSAL Node loopback on a random port). The app requests
  `Files.ReadWrite User.Read offline_access`.

## Proton API usage rules

- every request sends `x-pm-appversion: external-drive-marknotes@0.1.0-alpha`;
- only official Proton endpoints are used, through the official [Proton Drive SDK](https://github.com/ProtonDriveApps/sdk)
  (`@protontech/drive-sdk`);
- sync is event-based: the remote tree is traversed once and then kept up to date with the Drive event stream. Sync runs
  only on launch and on demand;
- no Proton logos or branding;
- the login screen states: "This is a third-party application not officially supported by Proton."

## Branding

The app icon is shared with the Android and web apps. The master SVGs live in `branding/` (`marknotes-icon.svg` for
the app icon, `marknotes-mark.svg` for the in-app logo). The rasters in `build/` (`icon.png`, `icon.ico`, `icon.icns`
and `icons/<size>.png` for Linux) are generated from them and committed; after changing an SVG run
`npm i --no-save @resvg/resvg-js && node branding/generate-icons.mjs`.

## License

MarkNotes is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Commercial use is not permitted.
Third-party dependencies remain under their own licenses. The Proton Drive SDK is GPLv3, so builds that include it must
respect the GPLv3.
