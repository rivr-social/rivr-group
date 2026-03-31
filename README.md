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
REGISTRY_URL=https://b.rivr.social/api/federation/registry
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

## Docs

- Quick start: `docs/QUICK_GROUP_INSTANCE.md`
- Deploy runbook: `docs/GROUP_APP_DEPLOY_RUNBOOK.md`

## Notes

- This app assumes the surrounding PM Core / Docker Lab storage, ingress, and database foundation exists.
- Runtime deployment still requires real `DATABASE_URL` and `AUTH_SECRET`.
