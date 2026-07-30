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

### Canonical entity links (federated-projection routing, 2026-07-14)

Port of the person app's canonical entity-link routing (person branch
`fix/2026-07-14-canonical-links`). Fixes the class where a link to a
REMOTE-HOMED entity (a federated projection) routed to a bare LOCAL path (empty
shell or 404), and the sibling live-404 class where ring/family owners were
linked to `/rings/<id>` / `/families/<id>` — routes this app does NOT have
(rings/families render under `/groups/<id>`).

- **`src/lib/federation/entity-link.ts`** — the pure, client-safe resolver
  (copied verbatim from person). `resolveRemoteHomeBaseUrl(metadata)` reads the
  home stamp (`homeBaseUrl` → `federatedHomeBaseUrl` → origin of
  `canonicalUrl`); `resolveEntityHref(metadata, localPath, {selfBaseUrl,
  globalFallback})` returns `{href, isRemote}`. A self-host stamp is treated as
  local (loop guard — own rows can carry a self-pointing canonicalUrl). Tests:
  `src/lib/federation/__tests__/entity-link.test.ts` (`pnpm test:unit`).
- **`src/components/canonical-link.tsx`** — `CanonicalLink` renders an absolute
  href as a plain `<a target="_blank" rel="noopener noreferrer">` (NEVER a Next
  `<Link>` — cross-origin RSC prefetch is the CSP-flash class) and a local path
  as `<Link>`. `navigateToHref(router, href)` is the imperative analog.
- **Group-app semantics: `globalFallback` is NOT used.** Unlike person, this
  app renders every entity class locally (`/groups`, `/projects`, `/profile`),
  so an unstamped row resolves to its local path. `agentLocalPath` maps
  ring/family/org → `/groups/<id>` (the 404 fix), project → `/projects/<id>`,
  person → `/profile/<username|id>`.
- **Stamps (in `graph-adapters.ts`):** `agentToGroup`/`agentToRing`/
  `agentToFamily`/`agentToProject` stamp `homeHref`; `agentToUser` stamps
  `profileHref`; `resourceToMarketplaceListing.ownerPath` routes through
  `agentCanonicalHref` (replacing the broken `/rings|/families` branch).
  `homeHref?` added to `Group`/`Ring`/`Family` in `src/lib/types.ts`.
- **Swept surfaces:** `ring-feed`, `family-feed`, `project-feed`, `group-feed`
  (incl. its own local `/rings|/families` ternary — same 404 class),
  `group-subgroups`, `group-affiliates`, `group-relationships`,
  `group-relationship-manager`, `people-feed`, `profile-group-feed`,
  `user-connections`, `marketplace-feed`, `group-marketplace-feed`,
  `post-feed` (author/creator/organizer/group card + card-click via
  `navigateToHref`), `post-detail-client` (author byline), `agent-graph`
  (member/subgroup node hrefs + click nav via `navigateToHref`), `search-bar`
  + `search-header` (result nav via `navigateToHref`),
  `app/(main)/profile/profile-client.tsx` (`getActivityObjectHref` routes all
  entity classes through `resolveEntityHref`).
- **Follow-up gaps (bare IDs, no home metadata in scope — need data-layer
  stamps before they can reach a sovereign home; they render local routes
  today, which exist here):** `comment-feed` (bare `authorId`), `receipt-card`
  (inline `seller`), `event-detail-tabs` attendee list, `event-card` /
  `calendar-event` (bare `groupId`/`projectId` props), `agent-graph` activity
  objects, `notifications` page (bare `targetId`).

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

## Connect accounts for subscribing members (2026-07-07)

Connected accounts are provisioned when an agent becomes a SUBSCRIBING member
(cooperative `subscriptions` rail, tiers basic/host/seller/organizer/steward),
not for every agent. The shared idempotent core is
`lib/connect-account.ts` (`ensureConnectAccountForAgent` /
`ensureConnectAccountForWallet` — the account-creation logic extracted from
`setupConnectAccountAction`; Custom controller account when
`STRIPE_CUSTOM_ACCOUNTS_ENABLED=true`, else Express; id persists at
settlement-wallet `metadata.stripeConnectAccountId`). Activation wiring: the
Stripe webhook's `handleSubscriptionUpsert` calls it (non-fatal) when a
membership subscription goes active/trialing, and
`api/stripe/subscription-success` reuses the same core for the interactive
onboarding redirect. Backfill for pre-wiring subscribers:
`actions/wallet/connect-backfill.ts` → `backfillConnectAccountsAction`
(admin-gated: platform `siteRole` or primary-group manage access; targets
active/trialing local subscribers + the group agent; concurrency-capped,
per-agent failure isolation, re-run safe) — also exposed as the
`rivr.payments.backfill_connect_accounts` MCP/assistant tool. Tests:
`wallet/__tests__/connect-backfill.test.ts` (pnpm test:db).

## Treasury funds (2026-07-07)

Named sub-pools of the group's main treasury ("Operations Fund", "Land
Fund"). A fund is a `resources` row with `type: 'resource'` +
`metadata.resourceKind: 'fund'` (the pg enum has no `fund` value — no
migration) owned by the group, with a resource-bound wallet via
`getOrCreateProjectWallet` (wallet `type: 'project'`,
`metadata.walletKind: 'fund'`). Subgroups are assigned to at most one fund
(`metadata.assignedSubgroupIds` on the fund). Money moves main ↔ fund over
`transferP2P` (internal ledger; `MAX_TRANSFER_CENTS` per move). Each fund is
FinancialAccount-READY: `provisionFundFinancialAccountAction` /
`issueFundCardAction` mirror the subgroup banking lane (ids on the fund
wallet metadata) and stay dormant behind `STRIPE_TREASURY_ENABLED` /
`STRIPE_ISSUING_ENABLED`. Actions: `actions/wallet/treasury-funds.ts`; UI:
`treasury-funds-card.tsx` in the Treasury tab (admins). Tests:
`wallet/__tests__/treasury-funds.test.ts` (pnpm test:db).

## Share classes — Steward/Worker equity (2026-07-09)

Hidden org-grade subgroups (`agents` row `type:'organization'`,
`metadata.groupType:'share_class'`, `hidden:true`, `netBps`, `shareCount`,
`tierKey`) that receive a **percentage of org NET** split among members **by
shares held**. Members hold shares via an active `belong` ledger edge to the
class carrying `metadata.shares` (interactionType `share-class-holding`).
Actions: `actions/wallet/share-classes.ts` — `createShareClassAction`,
`setShareClassAllocationAction` (netBps/shareCount, pie-validated),
`setMemberSharesAction`, `getShareClassOverviewAction` (admin),
`getMemberShareHoldingsAction` (member "Your Shares"), `getOrgMembersAction`.
Net integration: `resolveGroupNetAllocation` now folds in
`resolveShareClassAllocations` — each class resolved SEPARATELY (its own members
+ share weights) through the exact-sum `resolveNetAllocation`/`splitBpsByWeight`
rail, merged with the authored tree by recipient. No enum/schema migration
(metadata + existing ledger). UI: `share-classes-card.tsx` in the Treasury tab —
rendered for ALL members (self "Your Shares" view) with admin authoring gated by
`canManageStripe`. Steward/Worker are the canonical hidden classes; an org grants
the tier by assigning a member shares in the org's Stewards/Workers class.

## Dues gross-up pricing + federated payment principals (2026-07-11)

Group-membership dues are priced through `computeGroupSubscriptionChargePricing`
(`lib/group-subscription-pricing.ts`) — the canonical `calculateCheckoutFees`
gross-up with zero flat overhead — so the PAYER covers Stripe's 2.9% + 30¢ and
RIVR's 5% margin while the group nets the full plan face value on both
settlement rails (flat 5%-of-face netted the platform NEGATIVE on small dues).
Connect `application_fee_percent` derives from the gross-up; admin-configured
Stripe price IDs are honored only when they already cover the grossed-up total.
Every money surface (tier checkout, wallet deposit, payment-intent, Connect
return, subscription-success, marketplace checkout, billing + purchase actions)
resolves principals via the unified session (`getSession` +
`resolveLocalActorId`) and projects first-contact federated actors
(`ensureLocalActorAgent` / `getCurrentUserIdForWrite` in `actions/wallet/helpers.ts`)
before actor-keyed writes. Do not reintroduce plain `auth()` on economic routes.

## Job cash pay + completion payout (2026-07-07; project-wallet + volunteer 2026-07-13)

Jobs carry cash compensation alongside task points: `metadata.payKind`
(`'fixed' | 'hourly' | 'volunteer' | null`), `payAmountCents`,
`hourlyRateCents` — threaded through `JobShift`, `resourceToJobShift`, project
creation, the create-page job composer, and `rivr.jobs.update`.
`markJobDoneAction` (`actions/job-completion.ts`, also `rivr.jobs.mark_done`)
is admin/owner gated: flips the job to completed, records a `job-contribution`
edge per assignee (active `job-claim` holders, legacy `metadata.assignees`
fallback), and settles cash via `transferP2P` (fixed = equal split,
deterministic remainder; hourly = rate × stopped `time_entry` ledger
segments). **Payout source (2026-07-13): a job with a `projectId` debits the
PROJECT's treasury wallet** (`getOrCreateProjectWallet` — the budget the group
approved into it; underfunded → `pending_funds`, never a silent group-wallet
dip); project-less jobs pay from the group settlement wallet. Idempotent per
assignee via the `job-cash-payout` earn edge; re-running retries pending
payouts. **Volunteer pay (2026-07-13):** `payKind:'volunteer'` moves no cash —
on mark-done each volunteer gets a post-hoc Thanks VOUCHER (owned by the
volunteer, valued by `computeVoucherThanksValue` in `lib/voucher-valuation.ts`
— the VoucherBuilder formula, skill×difficulty×hours) which the GROUP redeems
by TRANSFERRING its own held thanks_token resources (oldest-first, no minting)
to the volunteer; all-or-nothing per assignee, `volunteer_pending_thanks` when
the group's pool is short, idempotent via the `job-volunteer-voucher` earn
edge (written only on successful transfer). Structural adds post-creation: `actions/job-management.ts` —
`addJobToProjectAction` / `addTaskToJobAction` (mirror the lifecycle nested
inserts, inherit parent visibility/scope; MCP `rivr.jobs.create` /
`rivr.tasks.create`). UI: `job-admin-panel.tsx` above the job tabs (edit
pay/details, add task, mark done) and `ProjectActions` gains server-computed
`canManage`, a budget field, and an Add-job dialog. IMPORTANT: admin
surfaces gate on SERVER-computed authority passed as props — the client
user-context cannot see federated remote-viewer sessions.

## Stake distribution (points-based, claim → attest since 2026-07-10)

Org stake is proportional to TASK POINTS earned across the group and its
subgroup tree (recursive `agents.parent_id`). The points rail is the `earn` /
`task-points-earned` ledger edge — written ONLY at ATTESTATION by
`@/lib/work-completion` (the single writer, shared by `toggleTaskCompletion`
and `updateTaskStatus`; never write it elsewhere). A worker's check-off is a
`work-completion-claim` edge (verb `complete`, reviewStatus 'claimed',
awaiting_approval, auto-linked to their RUNNING workperiod); verification by
the project QA / lead / group-or-ancestor admin (`canAttestWork`;
project `metadata.leadId`/`qaId`, QA defaults to lead, group-agent QA = that
group's admins) flips it to 'verified' and awards points (one ACTIVE edge per
worker+target — re-attest updates in place, reject/reopen deactivates claim AND
points). Job-level `metadata.points` (task-less jobs) settle at mark-done via
peer allocation (`@/lib/peer-allocation`: per-assignee sliders over the others
→ normalized average → largest-remainder; equal until rated).
`getMemberStakesForGroup` (lib/queries/stakes.ts) derives
`profitShare = memberPoints / subtreeTotalPoints`; net-allocation `class` rules
split their bps proportionally to the same weights
(`getSubtreeTaskPointsByMember` → `resolveNetAllocation(tree, classMembers,
memberWeights)`), falling back to an equal split only when nobody in the class
holds points. Group-only feature — do NOT port to locale/region.

## Job QA admin review + editable times/points (2026-07-13)

The attester's review surface on the job detail page — an admin-only **Review**
tab (`src/components/job-qa-review-tab.tsx`, gated by server-computed
`reviewData`, hidden for non-admins). Backed by `src/app/actions/job-qa.ts`:

- `getJobQaReviewData(jobId)` — per-assignee recorded work periods across BOTH
  timer rails (current `workperiod` resources + legacy `time_entry` ledger
  rows — the same two `getTrackedMsForAssignee` reads), their claim-complete
  ratings / proposed points, their attested points, and the DISCREPANCIES
  between claimed and recorded/attested values (claimed-with-0-tracked-time,
  time-over-`maxHours`, proposed-≠-attested, claim-awaiting-attestation).
  Returns null unless the viewer can manage/attest.
- `editWorkPeriodDurationAction` — corrects a recorded period's `durationMs`
  (admins on any row; a worker on their OWN), stamping
  `durationEditedBy`/`durationEditedAt`/`previousDurationMs` onto the row.
  Refuses a running period; hourly pay re-reads the corrected value at the
  next mark-done. Does NOT touch the points rail.
- `setAttestedPointsAction` — (re)settles a worker's points on a task or the
  job THROUGH `attestWork` (the single `task-points-earned` writer — never
  written directly here); zero routes through a `rejected` outcome to
  genuinely deactivate the edge.

Authority is resolved against the job RESOURCE's `owner_id` via the
remote-viewer-aware unified session (`getCurrentUserId ?? getAuthenticatedActorId`),
`hasGroupWriteAccess` (cascades via `isGroupAdmin`) + `canAttestWork`. Point
edits are gated by `canAttestWork`, never a bare membership check. Tests:
`src/app/actions/__tests__/job-qa.test.ts` (`pnpm test:db`).

**Authority-gating sweep (directive #5).** The jobs page (`jobs/[id]/page.tsx`)
now computes `canManage`/`canAttest` against the job resource's `owner_id` (the
node the server actions enforce), not the domain `job.groupId`
(`metadata.groupId`, often `""` or a different group — which silently hid the
admin panel from admins the server would authorize). **Project Jobs tab**
(`project-jobs-tab.tsx`) gained explicit Attest/Reject controls for admins on a
worker's `awaiting_approval` task (the checkbox there RETRACTED the claim via
`toggleTaskCompletion`; it is now locked for admins on claimed tasks so the
buttons are the control) — the attester now immediately sees approve/reject
without a reload, matching the job-detail Tasks tab.

**Job-level claim → attest morph (directive #6, round 2).** The WHOLE-JOB analog
of the task chips. `getJobShareData` (`actions/job-peer-allocation.ts`) now
returns `jobCompleted` + `jobClaimants` (everyone with an ACTIVE job-level
claim-complete awaiting review, with their skillfulness/difficulty). `JobPointsTab`
takes server-computed `canManage`/`canAttest` and, whenever a completion claim
exists and the job isn't done, renders a "Completion claimed — review & approve"
panel for attesters: `canManage` viewers get an **Attest & mark job done** button
(`markJobDoneAction` — settles pay/points, authority re-checked server-side),
others see "awaiting a group admin to settle". When the completer IS an attester,
the panel appears OPTIMISTICALLY right after their own claim-complete (self-QA),
before the refetch. (Job-level "approve" is mark-done — job points settle via peer
allocation at mark-done, so there is no standalone per-claim job attest.)

**Group Jobs board shows real data across subgroups (directive #7, round 2).**
The group Jobs tab (`job-board-tab.tsx`) computed each project card's jobs/points/
completion from `fetchResourcesByOwner(groupId)` — GROUP-owned rows only — so a
subgroup-owned project (owner = a circle agent) rendered "No jobs" / 0 points /
0% despite dozens of `metadata.projectId`-linked jobs, and card stats were 0
until a project was expanded. New owner-agnostic queries
`getJobsByProjectId` / `getTasksByJobIds` (`lib/queries/resources.ts`) + server
action `fetchProjectJobBoard` (`actions/graph/resources.ts`) aggregate a
project's jobs by `metadata.projectId` regardless of which subtree agent owns
the rows (visibility-respecting via `filterViewableResources`), computing
points/completion from CHILD `task` resources. The board eager-loads every
project's board on mount so cards show real numbers without expanding. Tests:
`lib/queries/__tests__/jobs-by-project.test.ts`,
`actions/__tests__/project-job-board.test.ts`,
`actions/__tests__/job-peer-allocation.test.ts` (`pnpm test:db`).

## Job card UX + pay labels + stable ordering (2026-07-14, round 3)

- **Pay-type badge on every job card** — `lib/job-pay.ts` `describeJobPay` is the
  single formatter ("Fixed $X" / "Hourly $X/hr" / "N points" / "Volunteer
  (Thanks)") + `JOB_PAY_TONE_CLASS`. Rendered on the project-page job cards
  (`project-jobs-tab.tsx`) and the Jobs-board cards (`job-board-tab.tsx`);
  `ProjectJobBoardJob`/`fetchProjectJobBoard` now carry
  `payKind`/`payAmountCents`/`hourlyRateCents`/`points`. Unit test:
  `lib/__tests__/job-pay.test.ts` (`pnpm test:unit`).
- **Card-level Claim** — `components/job-claim-button.tsx` calls the shared
  `claimJobAction` (full eligibility enforced server-side; approval-required →
  pending). On the project-page cards, the Jobs-board cards, and the project-card
  dropdown; stops propagation so it never toggles/navigates the card.
- **Job title links to `/jobs/[id]`** — the project-page card title is now a
  `Link` (stopPropagation so it navigates instead of toggling the collapsible).
- **Stable job/task ordering** — `buildJobsWithTasks` (project page) sorts by
  `createdAt` then `id` (both IMMUTABLE). Jobs/tasks previously JUMPED on every
  task check-off because the server-action refresh re-fetched in a mutable
  (updatedAt-derived) order. NEVER sort these lists by completion/updatedAt. The
  Jobs board orders by `created_at DESC` (stable) and has no task-toggle.
- **payKind edits take effect immediately** — `JobDetailClient` clears the
  optimistic `jobOverride` on every fresh `serverJob` (a `useEffect`), so a
  post-creation edit (e.g. fixed → volunteer) is no longer shadowed by the
  pre-edit snapshot. The complete path (`markJobDoneAction`) already reads
  `payKind` FRESH (no snapshot) — the volunteer branch engages on the edited
  value; the claim-complete skill/difficulty sliders (`JobPointsTab`) are NOT
  payKind-gated (they fire for all pay kinds, feeding the voucher valuation).
  Test: `actions/__tests__/job-completion-paykind-edit.test.ts` (`pnpm test:db`).

## Jobs/PM live-testing fixes (2026-07-14, round 4)

- **Volunteer Complete → voucher-creator dialog** — a `volunteer`-payKind job's
  Complete action now opens `components/volunteer-complete-dialog.tsx`
  (skillfulness + difficulty sliders + live Thanks-per-hour preview) instead of a
  plain confirm. Confirming calls `markJobDoneAction(jobId, { volunteerRating })`
  — a NEW optional 2nd arg that values EVERY volunteer's voucher from the
  completer's dialog ratings (each still scaled by their own hours), overriding
  the claim-complete self-ratings. Wired on both admin Complete surfaces:
  `job-admin-panel.tsx` ("Complete" button) and `job-points-tab.tsx` ("Attest &
  pay Thanks"; takes new `payKind`/`estimatedHours` props). The Thanks rail is
  unchanged (transfer group-held Thanks, never mint). MCP `rivr.jobs.mark_done`
  passes only `jobId` (falls back to claim ratings). Test:
  `actions/__tests__/job-completion-volunteer.test.ts` (override case, `pnpm test:db`).
- **Attest visibility on the PROJECT page** — `app/(main)/projects/[id]/page.tsx`
  was the one surface with BOTH the remote-viewer and wrong-authority defects:
  it resolved the viewer via bare `getCurrentUserId()` (no
  `getAuthenticatedActorId()` cookie fallback → SSO admins anonymous) and
  cascaded `isAdmin` against `metadata.groupId` (often "") instead of the project
  resource's OWNER. Now uses the fallback and cascades against the owning-agent
  authority set (`projectOwnerAgentId`/`groupId`/`ownerId`), so parent-group
  admins get the Jobs-tab Attest/Reject controls + every `canManage` panel. The
  job-detail page + its tabs were already correct (why attest showed on some
  views but not others).
- **Pay badge on the badge-detail job list** — `app/badges/[id]/badge-detail.tsx`
  "Available Jobs" cards now render the `describeJobPay` badge (the only card
  surface that was missing it; project-jobs-tab + job-board-tab already had it).
- **Header type chips** — a "Job" chip (`job-detail.tsx`) and "Project" chip
  (project page header) mark page type.
- **Discussion on jobs & projects** — a Discussion tab on both pages reuses the
  generic `components/comment-feed.tsx` (new `targetId` prop) bound to the
  job/project resource id — the same thread primitive events use, via
  `postCommentAction`/`fetchCommentsAction` (no schema/federation change).
- **Calendar on projects** — a Calendar tab reuses `components/group-calendar.tsx`
  fed by `getEventsByProjectId` + `getJobsByProjectId` (serialized), placing jobs
  on the project's own schedule.
- **Work periods out of Inventory** — `lib/stock.ts` `toStockInventory` now
  filters via `isStockInventoryResource`, which excludes non-tangible
  `resourceKind`s (`NON_STOCK_RESOURCE_KINDS` = `workperiod`, `fund`). Fixes all
  three inventory surfaces (job/project/group) at the shared adapter. Test:
  `lib/__tests__/stock.test.ts` (`pnpm test:unit`).
- **Zero-task Complete** — already satisfied: `JobAdminPanel`'s Complete/Mark-done
  renders on `canManage` with no task-count gate (the volunteer branch likewise).

## Sovereign payout → global Connect bridge (design only, 2026-07-14)

`docs/active/sovereign-payout-connect-bridge-design-2026-07-14.md` — SCOPE ONLY,
no code. How a sovereign job payout (`markJobDoneAction`'s internal
`transferP2P`) would trigger a real Stripe `Transfer` on GLOBAL's one-platform
Connect account via a federated payout-intent, what substrate already exists
(connect-account provisioning on subscribe, settlement-wallet
`stripeConnectAccountId`), and the safest first increment (a no-money "payout
readiness" projection). Do NOT implement money movement without Cameron.

## Navigation + UI wave (breadcrumbs, bottom nav, contrast, stake, gallery, 2026-07-14)

- **Hierarchical breadcrumbs (C17).** One reusable component
  `components/nav-breadcrumbs.tsx` (chevron-separated, muted, mobile-truncated,
  collapsing ellipsis dropdown — NOT a bare slash path) over the shadcn
  `ui/breadcrumb` primitives. The chain math is pure + unit-tested in
  `lib/breadcrumbs.ts` (`buildContainmentChain` appends the current page
  link-less; `collapseBreadcrumbs` collapses the middle, always keeping head +
  current). Wired: the group page (subgroup lineage, via
  `group-profile-header.tsx` — replaced its ad-hoc chevron nav), the project
  page (`(main)/projects/[id]/page.tsx` — chain from `projectOwnerAgentId` +
  `lineageAncestors`, the reliable owner, NOT `metadata.groupId`), and the job
  page (`jobs/[id]/page.tsx` computes the chain server-side from the job's
  `owner_id` group-lineage + linked project, passed to `JobDetailClient` as
  `breadcrumbItems`; falls back to the old "Part of project" line). Project
  cards: the Jobs-board card (`job-board-tab.tsx`) already carried
  `subgroupName`; now shown with a `FolderTree` icon so it reads as the parent.
  Test: `lib/__tests__/breadcrumbs.test.ts` (`pnpm test:unit`).
- **Bottom nav everywhere (C18).** The persistent mobile chrome (bottom nav +
  command-palette launcher + palette) was hoisted OUT of `app/(main)/layout.tsx`
  into `components/app-chrome.tsx`, rendered ONCE in the ROOT layout
  (`app/layout.tsx`), so every surface outside `(main)` — `/groups/[id]`
  subgroups, `/jobs/[id]`, `/events`, `/badges`, `/marketplace`, `/settings` —
  now has it. `AppChrome` hides itself on `/login` + `/auth`. The `(main)`
  layout is now just the page container.
- **Dark-mode contrast (D20).** Token-level fix in `globals.css`:
  `--muted-foreground` dark raised `175 15% 55%` → `175 13% 63%` (measured
  ~4.7:1 → ~5.8:1 against the dark teal card/bg, clearing WCAG AA with margin).
  Conservative, single-token; light mode untouched.
- **Stake points per subgroup (D21).** New READ-ONLY query
  `getMemberSubgroupPointsBreakdown` (`lib/queries/stakes.ts`) partitions a
  member's task points by the task resource's DIRECT `owner_id` (non-overlapping;
  sums back to the subtree total) off the SAME `earn`/`task-points-earned` rail —
  it NEVER writes points. Threaded group page → `group-tabs-client` (as a plain
  `Record`, since Map doesn't cross the RSC boundary) → `stake-tab.tsx`, which
  renders a "Your points by subgroup" card for the viewer + an inline per-member
  breakdown in the overview.
- **Instagram-style image grid (D22).** `media-gallery.tsx` gained a
  `layout: "cards" | "grid"` prop; `"grid"` is a dense, gapless, square,
  caption-less wall (3–5 cols) reusing the SAME lightbox. The group Press → Media
  gallery (`press-tab.tsx`) defaults to `grid` with a Grid/List toggle.
- **Polotno license key (D26).** `polotno-editor.tsx` now reads
  `NEXT_PUBLIC_POLOTNO_KEY` (public build-time env; falls back to empty → editor
  still works, just the SDK's unlicensed default). **Cameron must supply the key**
  to silence the "license key missing" warning — set `NEXT_PUBLIC_POLOTNO_KEY`
  in the group instance env. We do NOT suppress the watermark beyond Polotno's
  own `showCredit: false`.

## Group settings wave — personas, builder, assistant key, newsletter (2026-07-14)

- **Group personas in settings (D23a):** `components/group-persona-manager.tsx`
  surfaces the already-existing `actions/group-personas.ts` CRUD + the
  autobot-enabled toggle in a **Personas** tab on `/groups/[id]/settings`. Admin
  designates which child persona (or none) carries the group's AI assistant
  (`setGroupPersonaAutobotEnabled` — mutually exclusive). Distinct from the
  user-facing `persona-manager.tsx` (that manages the signed-in ACCOUNT's
  personas on `/profile`; these are children of the GROUP agent).
- **Site builder — group target + serve leg (D23b):** the builder already
  generated + published (`lib/builder/site-*`, `site_versions`/
  `site_publications`, migration 0046) but only built the signed-in user's OWN
  site and had NO serve route. Now: `/builder?group=<id>` builds the GROUP's site
  (admin-gated via `hasGroupWriteAccess`, `targetAgentId` threaded to
  `/api/builder/publish`), and **the serve leg** is public GET
  `groups/[id]/site/[[...path]]/route.ts` (streams the live version snapshot from
  the DB; index.html default; content-type by ext; traversal-safe; nosniff). No
  custom-domain/DNS lane at the time — superseded by the custom-domain port
  below (2026-07-14 PM). A **Site** tab in group settings links to both.

## Custom domains for published sites (2026-07-14)

Port of the person app's custom-domain lane (manual DNS v1 — no DNS-write
connectors here). A published site (personal OR group) can be served on the
owner's own domain:

- **Pure lane:** `lib/builder/site-host-resolve.ts` (normalizeHost,
  matchPublicationForHost on the DB-snapshot shape `publishedVersionId`,
  computeDomainVerification + injectable-DNS `verifyDomainPointsToApp`) and
  `lib/builder/site-serve.ts` (resolveSitePath/contentTypeFor/withSiteBase —
  now SHARED by both serve routes; the `/groups/[id]/site` route was refactored
  onto it). Tests: `lib/builder/__tests__/site-host-resolve.test.ts`
  (`pnpm test:unit`, 16 cases).
- **Service:** `site-service.ts` — `setDomainStatus`, `bindCustomDomain`
  (requires a live published version; DOMAIN_TAKEN when bound to another owner
  — the `site_publications_domain_idx` unique index backstops the race),
  `unbindCustomDomain`, `resolveBoundPublicationByHost`.
- **Host-dispatch:** `middleware.ts` rewrites any request whose Host is not
  this instance's own app host (from base-url env; fail-safe disabled when
  unset) to `app/site-host/[[...path]]/route.ts`, which resolves the bound
  domain and streams the snapshot with a minimal per-site CSP; HTML gets
  `<base href="/">` (domain-root serving).
- **API:** `/api/builder/domain` (GET state+records / POST verify|bind /
  DELETE unbind) — authority via `resolveSiteOwnerSubject` (remote-viewer-
  aware; `targetAgentId` names a group the caller must hold write access on).
- **UI:** `components/custom-domain-panel.tsx` in `/builder` (status, DNS
  records, Verify, Connect, Disconnect).
- **Operator prerequisite (NOT app code):** the instance's Traefik needs a
  catch-all router + HTTP-01 certs so unknown Hosts reach this container —
  same requirement as person `docs/CUSTOM_DOMAINS.md`. Schema needed NO
  migration (0046 already carried the domain columns).
- **Boundary:** the middleware matcher excludes some static extensions
  (.html/.json/.svg …) — generated sites link pages extension-lessly and the
  known asset types (css/js) pass through, but a deep link to a literal
  `*.html` path on a custom domain bypasses host-dispatch. Revisit if the
  generator ever emits .html hrefs.
- **Assistant admin key (D24):** a group admin can enter their own Anthropic API
  key OR Claude Code OAuth token; stored ENCRYPTED (secret-box) as
  `assistantApiKeyEnc` on the direct agent's `autobotSettings`, NEVER returned to
  the client (config fetch exposes only `hasAssistantApiKey`). The chat route
  decrypts server-side and threads `anthropicAuthToken` into `native-chat`, which
  branches on token type: `sk-ant-oat*` → Bearer + oauth-beta +
  CLAUDE_CODE_IDENTITY; real API keys → `x-api-key`, no beta/identity. Falls back
  to the instance env credential when unset. Actions:
  `setGroupAssistantApiKey`/`clearGroupAssistantApiKey` in
  `actions/group-assistant-config.ts`.
- **Newsletter opt-out gate (D25):** `isEmailEnabled` extracted to
  `lib/email-preferences.ts` (shared by group broadcast + newsletter);
  `resolveGroupMemberEmails` now excludes members who disabled email
  notifications, and `sendNewsletterAction` appends a non-tracking
  unsubscribe/preferences footer (→ `/settings?tab=notifications`) to the
  outbound HTML/text only (stored body untouched).
- **Cross-instance `job.claimed` emit (A8, emit side):** `lib/federation/
  job-claim-event.ts` (`JOB_CLAIMED_EVENT_TYPE='job.claimed'` +
  `buildJobClaimCalendarPayload`). `claimJobAction` + `reviewJobClaimRequest`
  (on approval) emit a self-describing calendar payload (claimant, job window,
  owning group, canonical job URL) so a claimant's HOME instance can materialize
  the job on their profile calendar. The MATERIALIZE half is required parity in
  person + global (projection consumer + a profile-calendar projection keyed on
  the locally-homed `claimantId`).

## Treasury cascade: consolidated ledger + funding + per-project FAs + budgets + reports (2026-07-14)

The money wave (backlog B10/B13–B15). All amounts integer cents; internal
treasury-to-treasury moves are net-zero so funding never double-counts.

- **Consolidated treasury ledger (B10).** `getGroupTreasuryLedgerAction`
  (`actions/wallet/treasury-ledger.ts`) resolves the group's WHOLE treasury tree
  (main settlement + funds + project wallets + subgroup wallets, recursive
  `parent_id` via `getGroupSubtreeIds`) and classifies each `wallet_transaction`
  as external inflow / external outflow / internal move, attributing every leg
  to the wallet that moved it. The old treasury tab read the VIEWER's PERSONAL
  wallet (`getTransactionHistoryAction`) and never showed job payouts (which
  debit the PROJECT wallet). Pure classifier + summarizer in
  `lib/treasury-ledger.ts` (`classifyTreasuryLeg`/`summarizeTreasuryLegs`,
  unit-tested). Managers see the full tree; members see only the group
  settlement wallet's legs. `treasury-tab.tsx` consumes it (Recent Activity /
  All Transactions / month-to-date cards).
- **Funding cascade (B13).** group→subgroup: `fundSubgroupBalanceAction`
  (`actions/wallet/subgroup-funding.ts`, NEW — internal `transferP2P`, gated on
  PARENT manage authority, child-of-parent check); subgroup/group→project:
  existing `transferProjectBalanceAction`; project→worker: `markJobDoneAction`.
  UI: `subgroup-banking-card.tsx` now always shows subgroups with a **Fund**
  control (works WITHOUT Stripe), FA/card controls nested behind Treasury flag.
- **Per-project FinancialAccounts (B13).** `actions/wallet/project-banking.ts`
  (`provisionProjectFinancialAccountAction`/`issueProjectCardAction`/
  `getProjectBankingOverviewAction`) mirrors the subgroup/fund FA lanes for
  projects, hosted on the owning group's Connect account, ids on the project
  wallet metadata — DORMANT behind `STRIPE_TREASURY_ENABLED`/
  `STRIPE_ISSUING_ENABLED` (the internal funding cascade needs no flag).
- **Budget rollup (B14).** Pure `lib/budget-rollup.ts`
  (`computeProjectBudget`/`rollUpBudgets`, unit-tested): committed (planned job
  cash + hourly ceilings + purchases + card + expenses) vs. spent (paid job cash
  + …) vs. authored `metadata.budget`, rolled project→subgroup→group→parent.
  Aggregation `actions/wallet/project-budget.ts`
  (`getProjectBudgetSummaryAction`/`getGroupBudgetRollupAction`): job cash from
  `getJobsByProjectId` + the `job-cash-payout` ledger sum; expenses from
  `project_expense` txns; purchases from `wallet_transactions.metadata.projectId`
  (buyer-side attribution — the stamp is a follow-up, so this reads 0 until
  purchase flows set it); card spend from `sumIssuingSpendForCardholder`
  (`lib/stripe-treasury.ts`, best-effort, 0 while dormant). UI:
  `project-budget-panel.tsx` (project page) + `budget-rollup-card.tsx` (group
  Treasury → Budget tab). Authority via `hasGroupWriteAccess` (cascades to
  parent admins).
- **Financial reports (B15).** `getGroupFinancialReportAction`
  (`actions/wallet/financial-report.ts`) composes the ledger P&L (by-type,
  date-ranged via new `untilIso` + `byType` on the ledger action) + the budget
  rollup. UI `financial-reports-card.tsx` (group Treasury → Reports tab): This
  month / Last month / YTD / All-time presets + CSV/JSON export.
- **Sales into a group's Connect account (B11–B12 prereq, AUDIT).** Offerings
  (`createProvidePaymentAction`, `/api/stripe/payment-intent`) + group
  subscriptions use real destination charges that correctly resolve the GROUP's
  settlement-wallet `stripeConnectAccountId` (group-aware
  `getSettlementWalletForAgent`). Marketplace products
  (`/api/stripe/marketplace-checkout`) + event tickets
  (`createEventTicketCheckoutAction`) settle via the platform
  capital-accounts model (internal ledger credit to the group + separate Connect
  payout rail) — BY DESIGN, not a destination charge. Do NOT convert these to
  destination charges without Cameron (changes the settlement model; live money).

## Virtual Meeting events — LiveKit room + identified-diarization transcript (2026-07-20)

An event can be a **Virtual Meeting**: its venue IS a LiveKit room on the
event page, the session is recorded **per participant track**, and a
speaker-identified transcript lands on the event afterward. Speaker labels
are exact by construction — each audio track belongs to one authenticated
agent identity (never WhisperX guess-diarization).

- **Create:** third Event Type option "Virtual Meeting (hosted here)" on
  `/create` → `createEventResource({ virtualMeeting: true })` writes
  `metadata.meetingKind: "virtual-meeting"` + `transcriptionEnabled: true`
  (fields already existed in `EventMetadataSchema`).
- **Lib:** `src/lib/meetings/` — `constants.ts` (env keys, deterministic
  `eventRoomName(eventId)` = `evt-<id>`, join-window, statuses),
  `livekit.ts` (config/room/token + `startTrackAudioEgress` via
  DirectFileOutput→S3 + `receiveWebhookEvent`), `event-window.ts` (pure
  join-window math), `meeting-recordings.ts` (pure per-egress state on
  `metadata.meetingRecordings`), `transcript-merge.ts` (pure: per-track
  segments → meeting-clock interleave → coalesced `**Name** [MM:SS]: text`
  markdown), `transcript-land.ts` (SYSTEM lane — the webhook has no session,
  so the transcript doc is landed with direct DB writes mirroring the exact
  `event-transcript` document shape the session lane produces),
  `recording-storage.ts` (S3 reader for egress files).
- **Routes:** `GET/POST /api/events/[id]/meeting` — join lane;
  `resolveAuthenticatedUserId` (NOT bare auth() — remote-viewer parity),
  electorate = manage access OR `canPostToGroup` OR `hasActiveEventRsvp`
  (now exported), join window enforced for non-managers.
  `POST /api/livekit/webhook` — LiveKit-signed (JWT) machine lane:
  track_published → start per-track audio egress; egress_ended /
  room_finished → when the meeting ended and no egress is active,
  transcribe each track (`transcribeAudioFileDetailed`, segments preserved),
  merge, land the transcript, stamp `meetingTranscriptProcessedAt`.
- **UI:** `components/event-meeting-panel.tsx` on the event page (status
  poll, Join → full-screen `<LiveKitRoom><VideoConference/>`, recording
  notice). Event page detects `meetingKind` (no more string-sniffing for
  this lane).
- **Env (instance):** `LIVEKIT_URL` (+ `LIVEKIT_API_KEY`/`_SECRET`) and
  `MEETING_RECORDINGS_S3_{ENDPOINT,ACCESS_KEY,SECRET_KEY,BUCKET,REGION}`;
  transcription reuses `WHISPER_TRANSCRIBE_URL`. Unset → routes 503/panel
  explains; recording silently off without storage config.
- **Tests:** `src/lib/__tests__/{transcript-merge,meeting-recordings,event-window}.test.ts`
  (`pnpm test:unit`, 20 cases).

## Builder assistant — agentic edit + publish inside /builder (2026-07-14)

Cameron's directive: "the assistant in builder should be able to edit and
deploy app and site codebases from right there in builder." V1 = site
workspaces (app codebases land with the own-environment/broker lane).

- **Toolset (pure):** `lib/builder/assistant-tools.ts` —
  `makeBuilderToolset(initialFiles, publish)` closes over a WORKING COPY and
  exposes `list_files` / `read_file` / `write_file` / `delete_file` /
  `publish_site` as `NativeChatToolSpec`s. Jail: `validateSitePath`
  (workspace-relative, no dot-leading segments, extension allowlist =
  html/css/js/json/svg/txt/xml), per-file 400KB / workspace 2MB / 60-file
  caps; `index.html` undeletable; publish is an INJECTED callback (module has
  no DB imports). Tests: `lib/builder/__tests__/assistant-tools.test.ts`
  (`pnpm test:unit`, 8 cases).
- **Route:** `POST /api/builder/assistant` — authority via
  `resolveSiteOwnerSubject` (remote-viewer-aware; `targetAgentId` = a group
  the caller must hold write access on). Loads the base workspace from the
  LIVE published snapshot (else generates fresh from resources), runs
  `nativeCloudChat` with the toolset (the existing Anthropic tool-use loop,
  `TOOL_LOOP_MAX_ITERATIONS`), and returns `{reply, files, changedPaths,
  published, publication, toolCalls}` so the UI previews edits BEFORE
  anything goes live. Group targets use the group's encrypted assistant key
  (D24) when configured, else the instance env credential — identical
  resolution to the group assistant chat route.
- **Publish path:** `publishSiteFiles(agentId, files, commitMessage)` in
  `site-service.ts` — the raw-files sibling of `publishSite` (which always
  REGENERATES from resources and would discard assistant edits). Same
  snapshot + publication mechanics; the system prompt forbids publishing
  unless the operator explicitly asked.
- **UI:** `components/builder-assistant-panel.tsx` in `/builder` — thin
  transcript + input; shows per-turn changed-file chips ("✎ style.css") and
  a "Published vN" badge; on publish it updates the publication state and
  `router.refresh()`es the version history.

## Federated writes: one write-actor resolver + visitor capabilities (2026-07-30, S-1)

A federated SSO identity (global-credential login → `rivr_remote_viewer` cookie,
no NextAuth session) got the full write UI while every social write refused with
"You must be logged in to …" — the actions resolved their principal with a
session-ONLY helper (`getOperatingAgentId` → `auth()`). Fixed at the resolver:

- **`lib/auth/write-actor-policy.ts`** — PURE decision (no session/db/cookie
  imports, so it is unit-testable): `decideWriteActor({principal, capability,
  standing, visitorScope})` + `WRITE_ACTOR_DENIAL_CODES` +
  `writeActorDenialMessage`. Policy: local session → allow; federated principal
  with local STANDING (this instance's primary agent, an active
  `own/manage/join/belong` edge, or metadata-authored admin) → allow (they are a
  member acting from a remote home, NOT a drive-by visitor); otherwise the
  owner-authored visitor policy decides (`/settings/visitor-access`,
  `federation/visitor-scope.ts` — read/react/comment/rsvp/message). Tests:
  `lib/auth/__tests__/write-actor.test.ts` (`pnpm test:unit`, 11 cases).
- **`lib/auth/write-actor.ts`** — the IO half: `resolveWriteActorPrincipal()`
  (execution context → `getSession()` → `getAuthenticatedActor()`, which also
  decodes the LEGACY packed cookie `getSession` cannot read) always returning
  THIS instance's local agent id via `resolveLocalActorId`, plus
  `resolveFederatedStanding()` and `resolveWriteActor()`.
- **Wired:** `postCommentAction` (capability `comment`, standing checked against
  the thread's owner group, local-session persona attribution preserved),
  `toggleLikeOnTarget` / `setReactionOnTarget` / `toggleThankOnTarget`
  (`react`), `setEventRsvp` (`rsvp`). Identity-only (no new capability gate, the
  policy models no authoring capability): `resource-creation/helpers.ts`
  `resolveAuthenticatedUserId` and `actions/event-form.ts` now NORMALIZE the
  cookie-derived home id to the local agent id — an un-normalized remote id
  silently failed every membership check (event/post/group creation).
  `/settings/visitor-access` (page + `api/admin/visitor-access`) accept either
  auth source, so the SSO-landed owner is no longer bounced to `/auth/login`.
- **This resolver never replaces authorization.** `canPostToGroup`,
  `hasGroupManageAccess`, ownership and tier checks still run against the
  resolved local actor. Do NOT reintroduce `getOperatingAgentId()` /
  `getAuthenticatedUserId()` in a user-facing write action.
- **Client half:** a structured `ActionResult` refusal must reach the user.
  `comment-feed.tsx` now renders the message INLINE (`role="alert"`) beside the
  composer as well as toasting — a toast alone read as a silent no-op.

## No crash-404s: render the not-found view, never a late notFound() (2026-07-30, S-3)

An ANONYMOUS visit to a missing/dangling entity rendered "… Not Found" and then
hard-crashed to "Application error" (React #310): the page calls `notFound()`
AFTER `generateMetadata` has already resolved and streamed, and that late
`notFound()` re-renders the AppRouter mid-hydration (same class as the
2026-07-15 sovereign-root flash). Logged-in renders resolve before the boundary
swaps, which is why only anonymous visitors saw it.

`components/page-not-found-view.tsx` is the extracted view (`app/not-found.tsx`
now renders it too, so route-level 404s and page-level ones look identical).
Every page that pairs `generateMetadata` with a data-miss now RETURNS
`<PageNotFoundView title=… message=… />` instead of throwing: `posts/[id]`,
`marketplace/[id]`, `groups/[id]`, `(main)/projects/[id]`,
`(main)/profile/[username]`, `events/[id]`. **Rule: if `generateMetadata`
awaits the same data the page awaits, the page must RENDER the not-found view,
not call `notFound()`.** (Ported from global `64ec174`, styled to this app's own
`app/not-found.tsx`.)

## Stripe webhook: acknowledge foreign-entity events (2026-07-30, M-6)

Every instance shares the ONE Stripe platform account, so this webhook receives
other instances' events. The per-lane `localAgentExists` guards catch the shapes
we know; anything slipping past reaches a wallet/engine/billing lookup that
throws `Agent not found: <id>`, which escaped to the top-level catch as a 500 →
Stripe retry storm (live on MAB: a dev-instance family agent). The catch in
`api/stripe/webhook/route.ts` now classifies via
`lib/stripe-webhook-errors.ts` `isForeignEntityError` (anchored
`/^Agent not found:/`): log
`[stripe-webhook] Acknowledging foreign-entity event <type> (<message>)` and
return 200 `{received:true, foreignEntity:true}`. A retry can never succeed for
an entity that is not local (or was deleted). EVERY other error still returns
500 so Stripe retries. Tests: `lib/__tests__/stripe-webhook-errors.test.ts`
(`pnpm test:unit`).

## Job claiming (baseline membership gate, 2026-07-10)

Claiming a job ALWAYS requires active membership in the owning group, or
group/ancestor admin authority (`isGroupAdmin` cascades via pathIds — parent
admins qualify and BYPASS badge gates). The old `claim_badges_jobs`
subscription capability gate is removed from the claim path — subscriptions
gate group/subgroup MEMBERSHIPS, never jobs (Cameron's standing rule). The
legacy `claimGateMembership` flag is subsumed; `claimGateAdmin`,
`claimApprovalRequired`, badges, and `maxAssignees` still apply. Active
claimants may add tasks to their claimed job (`addTaskToJobAction`), with
proposed points settling only via attestation. Jobs/tasks carry
`startDate`/`deadline` + `maxHours`; hourly payout CLAMPS to the job's
maxHours (proportional scale-down, floored) in `computeOwedPay`.

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
