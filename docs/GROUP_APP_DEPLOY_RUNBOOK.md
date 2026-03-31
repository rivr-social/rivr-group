# Group App Deploy Runbook

This is the operator runbook for deploying a standalone `rivr-group` instance.

## Canonical Source

- Repo: `rivr-group`
- Build command: `pnpm build`
- Runtime command: `pnpm start`
- Docker build: `docker build -t rivr-group:latest .`

## Required Runtime Environment

Minimum required env:

```bash
NODE_ENV=production
NEXTAUTH_URL=https://group.example.com
NEXT_PUBLIC_BASE_URL=https://group.example.com
AUTH_SECRET=<real-secret>
DATABASE_URL=postgres://...

INSTANCE_TYPE=group
INSTANCE_ID=<target-node-uuid>
INSTANCE_SLUG=<slug>
PRIMARY_AGENT_ID=<group-agent-uuid>
REGISTRY_URL=https://b.rivr.social/api/federation/registry
```

## Preconditions

1. DNS for the target host resolves to the server.
2. The target database exists.
3. Required PostgreSQL extensions are preinstalled by a DB admin:
   - `postgis`
   - `vector`
   - `pg_trgm`
4. The app user remains a normal DB user.
5. You know the target group agent UUID.

## Build And Deploy

### 1. Install and build

```bash
pnpm install
pnpm build
```

### 2. Run migrations

```bash
pnpm db:migrate
```

### 3. Start the app

```bash
pnpm start
```

Docker:

```bash
docker build -t rivr-group:latest .
docker run --env-file .env -p 3000:3000 rivr-group:latest
```

## Verification

The following must succeed:

1. `GET /api/health`
2. `GET /api/federation/registry`
3. `/` redirects to `/groups/<PRIMARY_AGENT_ID>`
4. `/groups/<PRIMARY_AGENT_ID>` loads
5. `/groups/<PRIMARY_AGENT_ID>/settings` loads for authorized users

## Failure Modes

If `/` does not route to the group view:

- `PRIMARY_AGENT_ID` is missing or wrong
- `INSTANCE_TYPE` is not `group`

If migrations fail:

- extensions are missing
- or they were not preinstalled by a DB admin

If the app builds locally but fails in deployment:

- runtime secrets are missing
- object storage settings are incomplete
