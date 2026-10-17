## Summary

<!-- What does this PR change and why? -->

## Checklist

- [ ] `npm run lint && npm run format:check && npm run typecheck && npm test` passes locally
- [ ] `npm run build && npm run e2e` passes locally
- [ ] Sync changes are covered by sync engine tests (against the fake remote drive store)
- [ ] Manifest format still compatible with the Android app (`.marknotes/manifest.json`, format 1)
- [ ] Proton requirements still met (`x-pm-appversion` header, official endpoints only, no Proton branding, third-party disclaimer on login)
