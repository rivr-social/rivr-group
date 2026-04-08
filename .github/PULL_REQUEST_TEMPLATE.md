## Summary

Describe what changed and why.

## Required Metadata

`change-classification`: shared-contract  
`promote-to-monorepo`: yes  
`affected-sovereignty-types`: [global, person, group, family, locale, bioregional]  
`interop-impact`: schema  

Allowed values:
- `change-classification`: `shared-contract` | `sovereign-specific` | `deployment-only`
- `promote-to-monorepo`: `yes` | `no` | `n/a`
- `interop-impact`: `none` | `schema` | `federation` | `permissions` | `data-contract`

Notes:
- If `change-classification` is `shared-contract`, `promote-to-monorepo` cannot be `n/a`.
- Keep `affected-sovereignty-types` as a bracketed list (e.g. `[global, person]`).

## Validation

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test` (or justify if skipped)

## Risks / Follow-ups

List any known risks, migration steps, or follow-up PRs.
