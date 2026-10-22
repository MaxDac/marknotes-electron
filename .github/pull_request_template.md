## Summary

<!-- What does this PR change and why? -->

## Checklist

- [ ] `npm run lint && npm run format:check && npm run typecheck && npm test && npm run test:parity` passes locally
- [ ] `npm run build && npm run e2e` passes locally
- [ ] Sync changes are covered by sync engine tests (against the fake remote drive store)
- [ ] Manifest format still compatible with the Android app (`.marknotes/manifest.json`, format 1)
- [ ] Proton requirements still met (`x-pm-appversion` header, official endpoints only, no Proton branding, third-party disclaimer on login)

## Parity impact

<!--
Does this change shared behaviour (note format, front matter/ids, note links, attachments, sync manifest, merge or
conflicts) or a user-facing feature listed in marknotes-spec features.md? See AGENTS.md.
-->

- [ ] No impact on the other MarkNotes apps
- [ ] Spec change: <!-- MaxDac/marknotes-spec PR; the spec/ submodule is bumped in this PR -->
- [ ] Android follow-up: <!-- MaxDac/MarkNotes issue/PR, or n/a -->
- [ ] Web follow-up: <!-- MaxDac/marknotes-web issue/PR, or n/a -->
