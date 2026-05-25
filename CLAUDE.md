# RIVR Group App — Agent & Contributor Guide

## What This Is

This is the **canonical sovereign group app** for the RIVR ecosystem. It runs
independently on a group's own infrastructure and federates to the global hub
(`app.rivr.social`) for cross-instance discovery and aggregation.

Each deployment represents a single group, organization, or community — the
root URL redirects to the configured primary group.

## How It Relates to Global

This repo shares a common codebase heritage with `rivr-social/rivr-app` (the
global app), but runs as an independent sovereign instance. Key differences:

- **Single-group focus.** The app serves one primary group, configured via
  `PRIMARY_AGENT_ID` and `INSTANCE_TYPE=group`.
- **Federation, not hosting.** Content is federated to/from global, not hosted
  there.
- **Credential authority delegation.** Password verification delegates to
  `app.rivr.social/api/federation/sso/issue` with local bcrypt fallback.
- **Subset of global routes.** Not every global page or API exists here.

## Tech Stack

Same foundation as global:
- Next.js 15, TypeScript, PostgreSQL/PostGIS/pgvector, Drizzle, NextAuth v5,
  MinIO, Matrix, Stripe
- **Package Manager:** pnpm 8
- **Dev port:** 3001

## Source Structure

```
src/
  app/
    (main)/           # Main layout (feed, calendar, etc.)
    api/
      federation/     # Federation endpoints (registry, mutations, sync)
      group/          # Group-specific operations
      agents/         # Agent management
      cron/           # Scheduled jobs
      health/         # Health check
      ...
    groups/           # Group pages (/groups/[id], /groups/[id]/settings)
    events/           # Event pages
    marketplace/      # Marketplace (local)
    posts/            # Post pages
    settings/         # Settings
    ...
  lib/                # Core modules
  components/         # React components
  db/
    schema/           # Drizzle schema
    migrations/       # SQL migrations (~41)
```

## Known Drift from Global

These are copied components that reference routes this app does not have.
**Do not add these routes — fix the components to remove or redirect the links.**

| Component | Broken Link | Issue |
| --- | --- | --- |
| `src/components/bottom-nav.tsx` | `/explore`, `/map` | [#2](https://github.com/rivr-social/rivr-group/issues/2) |
| `src/components/search-bar.tsx`, `search-header.tsx` | `/explore?q=...` | [#3](https://github.com/rivr-social/rivr-group/issues/3) |
| `src/components/CommandBar.tsx` | `/members`, `/docs`, `/governance`, `/marketplace` | [#4](https://github.com/rivr-social/rivr-group/issues/4) |
| `src/components/user-menu.tsx` | `/groups` (index) | [#5](https://github.com/rivr-social/rivr-group/issues/5) |
| `src/components/location-autocomplete-input.tsx` | `/api/locations/suggest` (global only) | [#7](https://github.com/rivr-social/rivr-group/issues/7) |
| `src/components/map.tsx` | `/api/map-style-tiles/` (missing route) | [#12](https://github.com/rivr-social/rivr-group/issues/12) |

### Other Known Issues

- [#6](https://github.com/rivr-social/rivr-group/issues/6): Event dates render
  as creation time — `graph-adapters.ts` reads `metadata.startDate` but create
  flow writes `metadata.date`
- [#8](https://github.com/rivr-social/rivr-group/issues/8): Jobs detail uses
  hardcoded `currentUserId = "user1"`
- [#9](https://github.com/rivr-social/rivr-group/issues/9): Federation mutation
  handlers return `accepted: true` for mutations not actually forwarded
- [#10](https://github.com/rivr-social/rivr-group/issues/10): Sovereign key
  cryptography is preview-only
- [#12](https://github.com/rivr-social/rivr-group/issues/12): Map tile default
  points to missing local API route

### Federation Gaps

- **Materializer parity:** This app's `importFederationEvents` only handles
  `eventType === "upsert"`. Global emits `resource.created`, `post.created`,
  `event.created`, etc. Real-time creates from global will not materialize here
  until the event type set is aligned.
- **Auto-projected agents:** When federation events reference unknown agents,
  `resolveLocalEntityId` creates entity_map rows but not agents rows — the
  materializer silently drops those resources.
- **Forwarding stubs:** Some mutation types return success without actually
  forwarding the work.

## Development

```bash
pnpm install
pnpm dev          # Start dev server (port 3001)
pnpm build        # Production build
pnpm db:migrate   # Run database migrations
```

## Deployment

See `docs/QUICK_GROUP_INSTANCE.md` and `docs/GROUP_APP_DEPLOY_RUNBOOK.md` for
sovereign deployment procedures.

Required env vars: `INSTANCE_TYPE=group`, `INSTANCE_ID`, `INSTANCE_SLUG`,
`PRIMARY_AGENT_ID`, `REGISTRY_URL`, `DATABASE_URL`, `AUTH_SECRET`, `BASE_URL`.

## Contributing Rules

1. **This is a sovereign app, not a copy of global.** Don't add global-only
   routes here. Fix or remove references to routes that don't exist.
2. **Federation changes must be coordinated.** If you change the federation
   event format, materializer, or peer auth in this repo, the same change must
   land in global and the other sovereign repos.
3. **No sensitive data in commits.** No IPs, passwords, secrets, or host paths.
4. **Update this file when you ship.** If you fix a drift item, remove it from
   the table above. If you add new routes or capabilities, document them.
5. **Test before claiming done.** `pnpm build` must pass.
