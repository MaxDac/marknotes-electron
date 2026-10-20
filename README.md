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

Requirements: Node.js (version in `.node-version`).

```sh
npm ci
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
The remaining deprecated `glob` 7, `inflight` and `rimraf` 2 packages come from electron-builder's
ASAR and Squirrel tooling. They require upstream updates; forcing newer majors would break their APIs.
Keep Vite 7 / React plugin 5 and TypeScript 6 until electron-vite and typescript-eslint support newer majors.

To use Dropbox and OneDrive in `npm run dev`, set `DROPBOX_APP_KEY` and `MSAL_CLIENT_ID` as environment variables.
Release builds read them at build time from the repository secrets (see below). Proton Drive needs no keys.

## CI/CD

- `checks.yml` (reusable) has four required checks: "Lint (eslint, prettier, tsc)", "Unit tests (vitest)",
  "E2E (Playwright Electron)" and "Build (linux)". `pr-ci.yml` runs them on pull requests and `main-ci.yml` runs them on `main`.
- `release.yml` is started manually (Actions → Release → Run workflow) with a `version` (`X.Y.Z`) and a `prerelease` flag.
  It runs the checks, builds installers on Linux (AppImage, deb), Windows (NSIS) and macOS (dmg, zip), and publishes a
  `vX.Y.Z` GitHub Release with the installers and `SHA256SUMS`.

Repository secrets:

| Secret                                                     | Purpose                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `DROPBOX_APP_KEY`                                          | Dropbox app key (PKCE, no secret). Optional; without it Dropbox shows as not configured.        |
| `MSAL_CLIENT_ID`                                           | Microsoft Entra application (client) ID. Optional; without it OneDrive shows as not configured. |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                             | Optional code-signing certificate (base64 p12) and password.                                    |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Optional macOS notarization.                                                                    |

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
