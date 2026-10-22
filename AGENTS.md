# Agent instructions

MarkNotes Desktop: the Electron app of the MarkNotes family. Read [README.md](README.md) for features, release and
Proton rules. This file is the canonical guide for coding agents; `CLAUDE.md` and `.github/copilot-instructions.md`
point here.

## Commands

CI runs these `package.json` scripts (the contract of `.github/workflows/checks.yml`); run the relevant ones before
committing:

```sh
git submodule update --init   # fetch spec/ (marknotes-spec) if the clone has no submodules
npm ci
npm run preview               # build and open the production app in Electron
npm run lint                  # eslint
npm run format:check          # prettier (npx prettier --write <files> to fix)
npm run typecheck             # tsc for main/preload/shared and renderer
npm test                      # vitest unit tests (test/)
npm run test:parity           # marknotes-spec golden fixtures (parity/, needs spec/)
npm run build                 # electron-vite bundles to out/
npm run e2e                   # Playwright Electron E2E (after build; on Linux use xvfb-run)
npm run deps:check            # no deprecated packages in the lockfile
npm run deps:audit            # zero npm audit findings at any severity
npm run dist                  # electron-builder installers to release/
```

Development installs automatically apply the dependency patch and install the pinned Electron runtime.
Production-only installs skip the runtime. To repair an incomplete runtime download, run
`npm exec -- install-electron`; to restore missing development dependencies, run `npm ci --include=dev`.

| CI check (PR CI → `Checks / …`)    | Command                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| Lint (eslint, prettier, tsc)       | `lint`, `format:check`, `typecheck`, lockfile registry check   |
| Unit tests (vitest)                | `npm test`                                                     |
| Parity (marknotes-spec fixtures)   | `npm run test:parity`                                          |
| E2E (Playwright Electron)          | `npm run build` + `xvfb-run npm run e2e`                       |
| Build (linux)                      | `dist --linux AppImage deb` + `scripts/linux-package-smoke.sh` |
| Package smoke (windows/macos)      | `dist` for NSIS and dmg/zip (x64 + arm64), unsigned            |
| Dependencies (deprecations, audit) | `deps:check`, `deps:audit`                                     |

PR CI also runs Dependency review (fails on high/critical), actionlint and CodeQL. Do not rename these jobs: the
names are required status checks in the `main` ruleset.

## Architecture

- `src/main/`: Electron main process. `driveService.ts` exposes the remote drives over IPC; `connectors/` holds the
  Proton Drive (official SDK, SRP login), Dropbox (OAuth PKCE) and OneDrive (MSAL) connectors; `vault.ts` encrypts
  tokens with `safeStorage`; `updater.ts` wraps electron-updater.
- `src/preload/`: the typed `window.api` bridge (`api.ts`); the renderer has no Node access.
- `src/renderer/`: React UI (`ui/`), IndexedDB storage and the sync manager (`data/`).
- `src/shared/`: platform-independent logic shared by main and renderer and mirrored by the other apps: front matter
  and note ids, note links, attachments, the sync manifest, three-way merge, the note store and the sync engine.
  Most parity-relevant code lives here.
- `test/` (vitest), `e2e/` (Playwright), `parity/` (spec fixture runner), `spec/` (marknotes-spec submodule, read-only
  here).

## Conventions

- TypeScript strict mode, ES modules, Prettier formatting; keep logic in `src/shared/` pure and covered by vitest.
- Sync changes need sync engine tests against the fake remote (`src/shared/fakeRemote.ts`).
- Keep the `.marknotes/manifest.json` format 1 compatible with Android and web.
- Dependencies: no deprecated packages and zero audit findings. Read the README dependency policy before adding or
  upgrading packages, and regenerate only the lockfile with `npm install --package-lock-only --ignore-scripts`.
- Proton requirements (also in the PR template): every request sends the `x-pm-appversion` header, only official
  Proton endpoints via the official SDK, no Proton logos or branding, and the login screen shows the third-party
  disclaimer "This is a third-party application not officially supported by Proton."
- Linux packages are x64 only (AppImage + deb). `scripts/linux-package-smoke.sh` asserts the package metadata; update
  it with any change to the `build.linux`/`build.deb` config.

## Sibling repositories and parity

| App                | Repository                                                                | Shared logic                                                     |
| ------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Spec               | [MaxDac/marknotes-spec](https://github.com/MaxDac/marknotes-spec)         | `note-format.md`, `features.md`, `fixtures/` (submodule `spec/`) |
| Android            | [MaxDac/MarkNotes](https://github.com/MaxDac/MarkNotes)                   | `core/src/main/kotlin/io/github/maxdac/marknotes/core/`          |
| Desktop (this one) | [MaxDac/marknotes-electron](https://github.com/MaxDac/marknotes-electron) | `src/shared/`                                                    |
| Web                | [MaxDac/marknotes-web](https://github.com/MaxDac/marknotes-web)           | `assets/js/` (TypeScript), `lib/` (Phoenix)                      |

All apps share one drive folder, so they must agree on the file format and sync behaviour.

- Changes to the note format, front matter or note ids, note links, attachments, the sync manifest, merge or conflict
  handling must land in marknotes-spec first (`note-format.md`, fixtures and `features.md` in one PR), then be mirrored
  in this app, Android and web. Bump the `spec/` submodule in the same PR as the desktop change.
- The fixture key of this app is `desktop`. `parity/specFixtures.test.ts` maps every fixture file to desktop code and
  fails on unmapped files. Never edit fixtures or loosen expectations here: when this app intentionally differs, add a
  `knownDivergence.desktop` entry in the spec (the runner then asserts the output still differs).
- User-facing features are tracked in `spec/features.md`; update it in the spec when a feature changes in any app.
- Inspect sibling code with the GitHub CLI, e.g.
  `gh api repos/MaxDac/MarkNotes/contents/<path> -H "Accept: application/vnd.github.raw"` or
  `gh search code --repo MaxDac/marknotes-web <term>`.
- To compare a feature across apps, use the parity-check prompt (`/parity-check` in Claude Code,
  `.github/prompts/parity-check.prompt.md` in Copilot).
- Fill in the "Parity impact" section of the PR template.
