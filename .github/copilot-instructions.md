# Copilot instructions

Read [AGENTS.md](../AGENTS.md) first: it has the commands, architecture, conventions and cross-app parity rules.
Key rules:

- Before committing, run `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test` and
  `npm run test:parity` (needs `git submodule update --init`).
- Do not rename CI jobs in `.github/workflows/`; they are required checks.
- Shared behaviour (note format, front matter/ids, note links, attachments, sync manifest, merge/conflicts) is defined
  in [marknotes-spec](https://github.com/MaxDac/marknotes-spec) (`spec/` submodule). Change the spec first, then mirror
  it here and in [MaxDac/MarkNotes](https://github.com/MaxDac/MarkNotes) (Android) and
  [MaxDac/marknotes-web](https://github.com/MaxDac/marknotes-web). Never edit `spec/fixtures` from this repository.
- Proton: send `x-pm-appversion`, use only official endpoints via the official SDK, no Proton branding, keep the
  third-party disclaimer on the login screen.
- No deprecated dependencies and zero npm audit findings (see the README dependency policy).
- To compare a feature across apps, use `.github/prompts/parity-check.prompt.md`.
