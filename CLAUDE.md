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

| Component | Broken Link | Issue | Status |
| --- | --- | --- | --- |
| `src/components/map.tsx` (`modules/map/MainMap.tsx`) | `/api/map-style-tiles/` (missing route) | [#12](https://github.com/rivr-social/rivr-group/issues/12) | open (low: `MainMap` is not rendered by any route; has Natural Earth fallback + `NEXT_PUBLIC_*` tile overrides) |

Resolved 2026-05-31 (sovereign route drift sweep — fixes adapted to this app's
own structure, NOT copied from the person app):

- **#2** `bottom-nav.tsx` — `/explore` and `/map` are global-discovery surfaces
  that don't exist here; both now link out to the federated global hub via
  `getGlobalUrl()` (matching the existing CommandBar map behavior).
- **#3** `search-bar.tsx` / `search-header.tsx` — the "search everything" /
  "see all results" action routed to a nonexistent local `/explore`; now routes
  to the global hub's `/explore?q=…` (this app has no local search-results
  surface; global aggregates federated content).
- **#4** `CommandBar.tsx` — `/members`, `/docs`, `/governance` now deep-link
  into the primary group's tabs via `/?tab=members|documents|governance` (the
  root page forwards a valid `?tab=` to `/groups/{PRIMARY_AGENT_ID}`).
  `/marketplace` was never drift — that route exists locally. The external
  global `/map` command is intentional and unchanged.
- **#5** `user-menu.tsx` — "My Groups" → `/groups` (no index) now points to `/`
  (the group home) and is relabeled "My Group" for this single-group instance.
- **#7** `location-autocomplete-input.tsx` — added a local, sovereign-safe
  `src/app/api/locations/suggest/route.ts` sourcing suggestions from local
  place/locale graph nodes (no global call); the component already degraded
  gracefully on a missing endpoint. Route was already in the `route-access.ts`
  public allowlist.

### Other Known Issues

- [#6](https://github.com/rivr-social/rivr-group/issues/6): RESOLVED
  2026-07-02 — `graph-adapters.ts` `agentToEvent` read only `metadata.startDate`
  (falling back to `createdAt`), but the create flow writes
  `metadata.date`/`time`, so events rendered at their creation time. Now
  composes the datetime range from `metadata.date` + `metadata.time` (matching
  the already-fixed `resourceToEvent` path), keeping `startDate` as an alternate
  for explicit-ISO records. Same latent bug fixed in locale + region.
- [#8](https://github.com/rivr-social/rivr-group/issues/8): RESOLVED 2026-06-01
  — jobs detail page now resolves the real `auth()` session user and threads it
  (or `null` for anonymous) through `JobDetailClient` and its tabs; no more
  hardcoded `currentUserId = "user1"`.
- [#9](https://github.com/rivr-social/rivr-group/issues/9): RESOLVED
  2026-06-09 — unimplemented mutation types now return `accepted: false` with
  `MUTATION_NOT_IMPLEMENTED` (501) or `UNKNOWN_MUTATION_TYPE` (400) instead of
  claiming success.
- [#10](https://github.com/rivr-social/rivr-group/issues/10): Sovereign key
  cryptography is preview-only
- [#12](https://github.com/rivr-social/rivr-group/issues/12): Map tile default
  points to missing local API route

Resolved 2026-06-12 (join-flow E2E on Regen Hub — same bugs existed in all 5
repos; fixes ported to global/person/locale/region working trees):

- **Pending join requests granted instant membership** — `requestGroupMembership`
  wrote the `membership_request` ledger row with `isActive: true`, and every
  membership predicate (`findActiveMembership`, `isGroupMember`, member counts)
  matches any active `join`/`belong` row, so applying to an approval-required
  group made you a member immediately; the approval queue was decorative.
  Fixed: pending requests are `isActive: false`; the two pending-request
  lookups key on `metadata.reviewStatus = 'pending'` instead of `isActive`.
  (`reviewGroupJoinRequest` already inserts the real membership row on approve.)
- **Badges tab 500** — `fetchUserBadges` joined `ledger.object_id = r.id::text`
  and `fetchVoucherClaims` joined `l.subject_id = a.id::text`, but both ledger
  columns are `uuid` on every live DB → `operator does not exist: uuid = text`.
  Casts removed; string params now cast `::uuid`.
- **Federated avatars blocked by CSP** — sovereign instances render images
  hosted on the global hub's asset store (`s3.rivr.social`), which was not in
  `img-src`. `middleware.ts` now derives the hub S3 origin from `REGISTRY_URL`.

### Federation Gaps

Resolved 2026-06-09 (coordinated parity sweep with global + person):

- **Materializer parity:** RESOLVED — the importer handles the full
  upsert/delete event-type sets via `RESOURCE_UPSERT_EVENT_TYPES` /
  `RESOURCE_DELETE_EVENT_TYPES` (no `post.*` types — this app does not
  support posts; that exclusion is intentional).
- **Auto-projected agents:** RESOLVED — resources arriving before their
  owner's agent event project a minimal private placeholder agent
  (`metadata.federatedPlaceholder: true`) AFTER passing the
  `PRIMARY_AGENT_ID` scope filter and group-membership gate; the next agent
  upsert from the same peer upgrades it in place. Locally owned agents are
  never overwritten.
- **Forwarding stubs:** RESOLVED — see #9 above.
- **Replay-window catch-up:** RESOLVED — the pull-sync cron passes
  `allowHistorical: true` so this instance can catch up after >7-day downtime
  (signature + nonce dedup still apply); push routes remain strict.

Resolved 2026-06-11 (Spirit instance — deployed live to `pmdl_rivr_group_boulder`):

- **Pull-sync peer auth:** RESOLVED — the deployed `federation-sync` cron was
  sending only `X-Instance-*` headers (no `x-peer-slug`/`x-peer-secret`), so
  every peer pull returned 401 and the instance ingested nothing. The cron now
  calls `resolvePeerAuthHeaders(peer.peerSlug, config.instanceSlug)` and sends
  the per-peer secret (`x-peer-slug` = US, the sender). This restored both the
  `cameron` (person) and `global` peer pulls.
- **Resource materializer fidelity:** RESOLVED — the importer's
  `resources` upsert mapped `name`/`type`/`description`/`metadata`/`tags` but
  dropped `content` and `embeds`, so federated posts materialized as
  title-only shells (body + linked offering/voucher embed lost). The
  materializer now carries `payload.content` and `payload.embeds`
  (coerced to the NOT-NULL `[]` default) on both insert and
  `onConflictDoUpdate`. Posts DO flow into the group via the generic `upsert`
  event (the `post.*` event-type exclusion above is unchanged — `post.created`
  is logged but the paired `upsert` is what materializes the row).
- **Deploy note:** these were undeployed local drift fixes; the live Spirit
  build predated them. Shipped via exact-file sync + `docker compose build
  rivr-group-boulder` + force-recreate. A peer-secret `.env` collision
  (`FEDERATION_PEER_SECRET_CAMERON` defined twice in `/opt/docker-lab/.env`,
  shared with the prod `rivr` service) also had to be split into a
  Spirit-scoped `SPIRIT_FEDERATION_PEER_SECRET_CAMERON` var.

## Creation Suite (Phase G parity — ported from person 2026-06-28)

Ported global's already-PROD creation suite into this sovereign group app for
parity. Adapted to the group's session-derived owner model (no global A7
connectors).

- **Design creation (P-G1):** `/create/design` (route group `(main)`) renders
  the Polotno canvas editor via `next/dynamic(..., { ssr: false })`
  (`components/design/design-editor-lazy.tsx` → `polotno-editor.tsx`). Saving
  goes through the `createDesignResource` server action
  (`app/actions/resource-creation/designs.ts`), which lands the export as an
  `image` Resource (no migration). Requires the `react-konva: ^19.2.5` pnpm
  override (React-19 crash fix). Owner-media "My Photos" panel
  (`GET /api/design/media`) replaces Unsplash; it is owner-scoped via
  `resolveAuthenticatedUserId` + `hasGroupWriteAccess` (server-side, never
  client-trusted).
- **Media gallery (P-G2):** the group's media gallery — built from its posts +
  image/video + listing/event resources (`collectGalleryItems`,
  `components/media-gallery.tsx`). As of the app-review parity batch (2026-06-29)
  it is no longer a top-level page tab: it now renders inside **Press → Media**
  (`group-tabs-client` excludes `gallery` from the page-tab strip via
  `NON_PAGE_TAB_KEYS`; `press-tab` shows the gallery above external sources).
  The `gallery` key is still **retained** in the canonical tab registry
  (`src/lib/types.ts`: `GROUP_TAB_KEYS`, `DEFAULT_TAB_VISIBILITY` = public,
  `GROUP_TAB_LABELS`) so tab-visibility settings keep working.
- **Validated social links (P-G2):** `components/social-links-editor.tsx` on the
  settings form; final validation/normalization happens **server-side** in
  `updateProfileAction` via `validateSocialLinks` (`src/lib/social-links.ts`).
- **Tab visibility (P-G3):** already present (predates this port).

## Subgroup banking lane (Treasury FA per subgroup + Issuing, 2026-07-06)

Extends the dormant Stripe Treasury foundation (architecture doc §3.3–3.5,
Phases 2–3): `actions/wallet/treasury-banking.ts` adds
`provisionSubgroupFinancialAccountAction` (one FinancialAccount per subgroup,
HOSTED on the parent group's Custom Connect account; ids persist on the
subgroup wallet metadata incl. `stripeHostConnectAccountId`),
`issueSubgroupCardAction` (company cardholder per subgroup + virtual card
tethered to the subgroup FA, mandatory spending limit, default $500/month),
and `getGroupTreasuryBankingOverviewAction` (group Connect balance + group FA
+ linked external bank + per-subgroup FA balances/cards). UI:
`subgroup-banking-card.tsx` in the Treasury tab (admins only). Issuing
helpers live in `lib/stripe-treasury.ts` behind the NEW
`STRIPE_ISSUING_ENABLED` flag (separate Stripe program approval from
Treasury). Tests: `wallet/__tests__/treasury-banking.test.ts` (pnpm test:db,
Node ≥22).

## Stake distribution (points-based, 2026-07-02)

Org stake is proportional to TASK POINTS earned across the group and its
subgroup tree (recursive `agents.parent_id`). The points rail is the `earn` /
`task-points-earned` ledger edge written by `toggleTaskCompletion`
(`metadata.points`). `getMemberStakesForGroup` (lib/queries/stakes.ts) derives
`profitShare = memberPoints / subtreeTotalPoints`; net-allocation `class` rules
split their bps proportionally to the same weights
(`getSubtreeTaskPointsByMember` → `resolveNetAllocation(tree, classMembers,
memberWeights)`), falling back to an equal split only when nobody in the class
holds points. Group-only feature — do NOT port to locale/region.

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
