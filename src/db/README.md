# Database Module

Source-verified on 2026-05-20 against `schema.ts`, `index.ts`, `migrate.ts`,
`seed.ts`, `queries.ts`, and `src/db/migrations`.

## Current Source Shape

- `schema.ts`: Drizzle schema with 28 exported `pgTable(...)` tables and 17
  exported `pgEnum(...)` enums.
- `index.ts`: creates the shared Drizzle client, re-exports the schema, and
  exports `db`, `closeDatabase()`, `testConnection()`, and `healthCheck()`.
- `migrate.ts`: script entrypoint that applies SQL migrations from
  `./src/db/migrations`.
- `queries.ts`: shared query helpers.
- `seed.ts`: demo/system data seeding script.
- `migrations/`: 41 SQL migration files.

## Runtime Behavior

`index.ts` reads `DATABASE_URL`, then `DATABASE_URL_FILE`, then falls back to a
placeholder local Postgres DSN so build-time module initialization can proceed
without a real database URL. At runtime, deployments still need a real
`DATABASE_URL`.

The PostgreSQL client uses a bounded pool, finite timeouts, and `prepare:
false`. The disabled prepared-statement setting is intentional in this source
because query params are sanitized to convert `Date` objects to ISO strings
before Drizzle/postgres.js binding.

`healthCheck()` verifies both database connectivity and extension presence for:

- `postgis`
- `vector` / pgvector

Location-search migrations also install/use `pg_trgm` for Overture place search
indexes.

## Core Tables

Important exported tables include:

- `agents`
- `resources`
- `ledger`
- `nodes`, `nodePeers`, `nodeMemberships`
- `federationEvents`, `federationEntityMap`, `federationAuditLog`
- auth tables: `accounts`, `sessions`, `verificationTokens`
- billing/wallet tables: `subscriptions`, `wallets`, `walletTransactions`,
  `capitalEntries`
- group/runtime tables: `groupMatrixRooms`, `authorityEventCache`,
  `linkPreviews`, `peerSmtpConfig`, `groupConnections`,
  `resourceExternalSync`, `cronStateGoogleCalendar`

## Commands

The root `package.json` exposes:

```bash
pnpm db:migrate
pnpm db:seed
pnpm db:seed:overture
pnpm db:backfill:embeddings
```

`package.json` also contains `pnpm db:generate`, but this repo currently has no
`drizzle.config.*` file at repo root. Add or restore a Drizzle config before
relying on migration generation in this standalone repo.

## Usage

```ts
import { db, healthCheck } from "@/db";

const health = await healthCheck();
const group = await db.query.agents.findFirst();
```

All schema types are inferred from Drizzle exports in `schema.ts`.
