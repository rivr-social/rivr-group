# Sovereign payout → GLOBAL Connect bridge — design note (2026-07-14)

**Status:** design/scope only. NO code in this note or the round-3 branch.
**Author context:** jobs-qa-ux agent, at Cameron's request during live Spirit testing.

## The ask

When a sovereign instance (e.g. Spirit of the Front Range) pays a participant —
today via `markJobDoneAction` (job cash payout), and by extension project
settlement / net distribution — Cameron expects **real Stripe (sandbox) money**
to reach that participant through **GLOBAL's Connect platform**, under the
one-platform architecture where `app.rivr.social` is the single Stripe platform
account and every sovereign participant's connected account is hosted under it.

Today, sovereign payouts move **only inside this instance's internal USD
ledger** (`transferP2P`). No Stripe transfer leaves the platform; the payout is a
reconciliation record, not a real-money movement to the payee's bank.

## What exists already (the substrate — do not rebuild)

1. **Connected-account provisioning** — `lib/connect-account.ts`
   (`ensureConnectAccountForWallet` / `ensureConnectAccountForAgent`): idempotent,
   creates a Custom (controller) account when `STRIPE_CUSTOM_ACCOUNTS_ENABLED`
   else Express, and persists the id at the settlement wallet's
   `metadata.stripeConnectAccountId`. Wired to run when an agent becomes a
   **subscribing** member (Stripe webhook `handleSubscriptionUpsert` +
   `subscription-success`), with `backfillConnectAccountsAction` for pre-wiring
   subscribers. So many participants ALREADY have a Connect account id on file.
2. **Settlement wallets** carry `metadata.stripeConnectAccountId` — the exact
   handle a `Transfer` destination needs.
3. **The internal payout point** — `markJobDoneAction` → `payAssignee`
   (`actions/job-completion.ts`) moves `amountCents` via `transferP2P(payerWallet,
   assigneeWallet, …)` and mints a `receipt` stub. This is the single, idempotent
   (`job-cash-payout` earn edge) money moment; the doc header already names it the
   "reconciliation anchor" for a future Stripe leg.
4. **Federation write facade** — `federatedWrite` (`lib/federation/remote-write.ts`)
   already routes a write either `local` or `remote` (forwards to the home
   instance). `markJobDoneAction` runs its settle inside this facade. Sovereign
   instances federate to `app.rivr.social` for aggregation (ecosystem routing).
5. **Treasury/Issuing scaffolding** — dormant behind `STRIPE_TREASURY_ENABLED` /
   `STRIPE_ISSUING_ENABLED`; `OutboundTransfer` is the eventual Treasury leg. The
   nearer-term rail is a platform **`Transfer`** to the payee's connected account.

## The gap

- The payee's `stripeConnectAccountId` lives under **GLOBAL's** platform (or must
  be provisioned there), but the payout is computed and recorded on the
  **sovereign** instance's DB with **no Stripe key for the global platform**.
- Sovereign instances must not hold the global platform's secret key. So the
  real-money leg cannot be initiated locally; it must be **requested of global**.

## Proposed shape (one-platform, federation-mediated payout rail)

Keep the internal ledger transfer as the source of truth and add a **payout
intent** that global fulfills as a Stripe `Transfer`:

1. **Sovereign side (unchanged money math):** `payAssignee` still records the
   internal `transferP2P` + `job-cash-payout` edge. Additionally emit a
   **payout-intent** federation event — `{ payeeAgentId, amountCents, currency,
   sourceJobId, idempotencyKey = job-cash-payout edge id }` — to the home hub via
   the existing `federatedWrite` / event rail. The edge id is the natural
   idempotency key (one real transfer per internal payout).
2. **Global side (holds the platform key):** a new handler resolves the payee's
   connected account (`metadata.stripeConnectAccountId`, provisioning it via the
   existing `ensureConnectAccountForAgent` if absent), verifies the sovereign
   instance is an authenticated peer (signed event / peer registry — the SAME
   verified-principal model federation already uses), checks the platform balance
   / group's available funds, and creates a Stripe **`Transfer`** to that account
   with the forwarded idempotency key. Result (transfer id / status) federates
   back and is stamped on the sovereign receipt stub.
3. **Funding model (decide before build):** whose money funds the transfer —
   the paying group's Connect balance on the platform, a platform float, or a
   charge→transfer (destination charge) at the point of sale. This is the crux
   and a governance/accounting call, not a mechanical one.

## Safest increment (recommended first step, still no money movement)

**A dry-run "payout readiness" projection**, no Stripe writes:

- On the global side, for each sovereign payout intent (or as a report), resolve
  the payee's connected-account status: `has account?`, `charges/payouts
  enabled?`, `platform/group balance sufficient?` — and return a per-payee
  **`payout_ready | needs_onboarding | insufficient_funds`** verdict, stamped on
  the receipt stub. This reuses `ensureConnectAccountForAgent` +
  wallet-metadata reads ONLY (already present), proves the federation
  intent→global→back round-trip end to end, and surfaces exactly which
  participants are blocked on Connect onboarding — WITHOUT initiating a single
  Stripe transfer. The real `Transfer` leg becomes a small, well-scoped follow-up
  gated behind a flag (`STRIPE_CONNECT_PAYOUTS_ENABLED`) once the funding model is
  chosen and readiness is green in sandbox.

## Cross-repo coordination

The real-money leg is a GLOBAL (`rivr-social/rivr-app`) capability — the handler,
platform key, and `Transfer` call live there; this sovereign repo only emits the
intent + records the returned status. Per the workspace federation rules, the
event shape + peer-auth for the payout-intent rail must land in global AND every
sovereign repo together. No sovereign instance ever holds the platform secret.
