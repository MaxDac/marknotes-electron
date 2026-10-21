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
- **Appearance**: theme System, Light or Dark, and an accent colour from 8 palettes.
- **Multi-drive two-way sync** with any number of Proton Drive, Dropbox and OneDrive accounts. Sync runs on launch and
  on **Sync now** (no background polling). It keeps per-drive state and the `.marknotes/manifest.json` manifest, and merges lines
  three-way against the last synced version. Conflicts are resolved per change: Mine, Theirs, Both, Neither, or edit by hand.
- **Proton login**: SRP password login with TOTP. CAPTCHA/human verification, two-password mode and FIDO2-only
  accounts are not supported.
- **Dropbox / OneDrive login**: OAuth 2 PKCE (Dropbox) and MSAL (OneDrive) in the system browser, with a loopback redirect.
- Tokens are encrypted with Electron `safeStorage` (OS keychain).

Out of scope: search, tags, attachments, background sync, local encryption.

## Development

Requirements: Node.js (version in `.node-version`) and Git (used to apply the pinned build-dependency patch).

```sh
npm ci
npm run deps:check     # no deprecated packages anywhere in the lockfile
npm run deps:audit     # zero known vulnerabilities, including dev/optional/peer dependencies
npm run dev            # start the app with hot reload
npm run lint           # eslint
npm run format:check   # prettier
npm run typecheck      # tsc
npm test               # vitest unit tests
npm run build          # production bundles (electron-vite)
npm run e2e            # Playwright Electron E2E (run `npm run build` first)
npm run dist           # installers via electron-builder, written to release/
```

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
  unit tests, Electron E2E, Linux AppImage/deb packaging, and unsigned Windows NSIS/macOS dmg/zip packaging
  (both macOS architectures). PR, main and release workflows all inherit these checks; release packaging waits for them.
- `pr-ci.yml` also runs "Dependency review" (fails on new dependencies with low or higher advisories) and
  "Lint workflows (actionlint)".
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
   `latest-linux.yml`), the `*.blockmap` files for differential downloads, and `SHA256SUMS`.

`package.json` is not bumped in git; the workflow sets the version only for the build.

### Repository secrets

| Secret                                                     | Purpose                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `DROPBOX_APP_KEY`                                          | Optional override of the built-in public Dropbox app key (PKCE, no client secret). |
| `MSAL_CLIENT_ID`                                           | Optional override of the built-in public Microsoft Entra application (client) ID.  |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                             | Optional code-signing certificate (base64 p12) and password.                       |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Optional macOS notarization.                                                       |

Without the signing secrets the installers are unsigned: Windows SmartScreen and macOS Gatekeeper warn on first launch.

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

## License

MarkNotes is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Commercial use is not permitted.
Third-party dependencies remain under their own licenses. The Proton Drive SDK is GPLv3, so builds that include it must
respect the GPLv3.
