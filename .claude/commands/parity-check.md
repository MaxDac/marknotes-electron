---
description: Compare a feature across the MarkNotes apps (desktop, Android, web) and the spec
argument-hint: <feature>
---

Feature: $ARGUMENTS

Compare how the MarkNotes apps implement a feature and report parity gaps. Do not change code unless asked.

Repositories (see AGENTS.md):

- Spec: `spec/` submodule = [MaxDac/marknotes-spec](https://github.com/MaxDac/marknotes-spec) (`note-format.md`,
  `features.md`, `fixtures/`). Run `git submodule update --init` if `spec/` is empty, and compare its pinned commit
  with `gh api repos/MaxDac/marknotes-spec/commits/main --jq .sha`.
- Desktop (this repository): `src/shared/`, `src/main/`, `src/renderer/`; fixture runner in `parity/`.
- Android: [MaxDac/MarkNotes](https://github.com/MaxDac/MarkNotes), shared logic in
  `core/src/main/kotlin/io/github/maxdac/marknotes/core/`, UI and sync wiring in `app/`.
- Web: [MaxDac/marknotes-web](https://github.com/MaxDac/marknotes-web), client logic in `assets/js/`, Phoenix in `lib/`.

Steps:

1. Find the feature in `spec/features.md` (rows and "Known divergences") and, for format or sync behaviour, in
   `spec/note-format.md` and the matching `spec/fixtures/<area>/*.json` (including `knownDivergence` entries).
2. Find the desktop implementation and its tests in this repository.
3. Find the Android and web implementations without cloning, using the GitHub CLI on their default branch:
   - `gh search code --repo MaxDac/MarkNotes "<term>"` and `gh search code --repo MaxDac/marknotes-web "<term>"`
   - `gh api "repos/MaxDac/<repo>/git/trees/main?recursive=1" --jq '.tree[].path'` to list files
   - `gh api repos/MaxDac/<repo>/contents/<path> -H "Accept: application/vnd.github.raw"` to read a file
   - `gh pr list --repo MaxDac/<repo> --search "<term>"` for in-flight changes
4. Compare behaviour, not code style: inputs and outputs, edge cases, file format written to the drive, sync and
   conflict handling, UI entry points and settings.
5. Report:
   - a table with one row per behaviour and columns Spec, Android, Desktop, Web (Yes / No / Differs, with file links);
   - gaps: behaviour missing or different in an app, and whether the spec, `features.md` or fixtures already record it;
   - spec gaps: behaviour all apps share but the spec or fixtures do not cover;
   - suggested follow-ups, ordered by impact on shared drive data (format and sync first, then UI).
