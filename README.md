# Rivr Group

Standalone Rivr group-instance app and deployment guide.

This repo is the small sovereign group distribution for organizations, communities, and collectives that want to run their own Rivr home instance for a specific group agent.

## Required PM Core Links

You need the host foundation first.

- PM Core: `https://github.com/peermesh/pm-core`
- Docker Lab: `https://github.com/peermesh/docker-lab`
- PM Core main branch: `https://github.com/peermesh/pm-core/tree/main`

## What Is In This Repo

- Next.js group-instance app under `src/`
- database schema and migrations under `src/db/`
- federation routing and resolution under `src/lib/federation/`
- standalone `Dockerfile`
- example compose and env files
- operator docs under `docs/`

You do not need the full Rivr monorepo to build or run this repo.

## Current Source Shape

Source verification on 2026-05-20 found:

- 689 TS/TSX files under `src`
- 48 page routes
- 57 route handlers total: 46 under `/api` plus 11 non-API route handlers
  (`.well-known`, text/assets, and symbolic media routes)
- 126 server-action files
- 203 component files
- 140 `lib` files
- 41 SQL migration files under `src/db/migrations`

## Group Instance Model

The root route redirects to the configured primary group:

- `INSTANCE_TYPE=group`
- `PRIMARY_AGENT_ID=<group-agent-uuid>`

When correctly configured, `/` resolves to `/groups/<PRIMARY_AGENT_ID>`.

## High-Level Setup Flow

### 1. Bring up PM Core / Docker Lab

```bash
git clone https://github.com/peermesh/docker-lab.git /opt/pm-core
cd /opt/pm-core
cp .env.example .env
./scripts/generate-secrets.sh
docker compose up -d
```

### 2. Prepare PostgreSQL extensions

Rivr requires:

- `postgis`
- `vector`
- `pg_trgm`

Preinstall them as a database admin before running app migrations.

### 3. Clone and build this repo

```bash
git clone https://github.com/rivr-social/rivr-group.git
cd rivr-group
cp .env.example .env
pnpm install
pnpm build
```

### 4. Configure runtime env

At minimum:

```bash
INSTANCE_TYPE=group
INSTANCE_ID=<node-uuid>
INSTANCE_SLUG=<slug>
PRIMARY_AGENT_ID=<group-agent-uuid>
REGISTRY_URL=https://app.rivr.social/api/federation/registry
NEXTAUTH_URL=https://group.<your-domain>
NEXT_PUBLIC_BASE_URL=https://group.<your-domain>
DATABASE_URL=postgres://...
AUTH_SECRET=<real-secret>
```

### 5. Start it

Direct process:

```bash
pnpm start
```

Docker:

```bash
docker build -t rivr-group:latest .
docker run --env-file .env -p 3000:3000 rivr-group:latest
```

## Verification

The deployed group instance should expose:

- `/api/health`
- `/api/federation/registry`
- `/api/federation/mutations`
- `/groups/<PRIMARY_AGENT_ID>`
- `/groups/<PRIMARY_AGENT_ID>/docs`
- `/groups/<PRIMARY_AGENT_ID>/settings`

Basic checks:

```bash
curl https://group.<your-domain>/api/health
curl -I https://group.<your-domain>/
```

## Current Source Caveats

This README describes the intended group-instance shape. Current source-review
findings are tracked in the workspace root:

- `../../docs/active/source-code-review-2026-05-18.md`
- `../../docs/active/open-issues.md`

As of 2026-05-19, known group issues include stale local navigation targets,
search links to a missing local `/explore` route, missing local
`/api/locations/suggest`, a Cesium map default tile URL that points at a
missing local `/api/map-style-tiles/{z}/{x}/{y}` route unless a basemap URL is
configured, event date adaptation drift, hardcoded job-detail identity, and
federation mutation handlers that can return accepted stub states.
Check those docs and the GitHub issues before treating every listed surface as
fully wired.

## Docs

- Quick start: `docs/QUICK_GROUP_INSTANCE.md`
- Deploy runbook: `docs/GROUP_APP_DEPLOY_RUNBOOK.md`

## Notes

- This app assumes the surrounding PM Core / Docker Lab storage, ingress, and database foundation exists.
- Runtime deployment still requires real `DATABASE_URL` and `AUTH_SECRET`.
