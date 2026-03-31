# Spin Up Your Own Rivr Group Instance

## What You Need

- a server running Docker
- a domain name pointing to that server
- your group agent UUID
- a PM Core / Docker Lab host foundation

## Steps

### 1. Bring up PM Core

```bash
git clone https://github.com/peermesh/docker-lab.git /opt/pm-core
cd /opt/pm-core
cp .env.example .env
./scripts/generate-secrets.sh
docker compose up -d
```

### 2. Prepare PostgreSQL

Install:

- `postgis`
- `vector`
- `pg_trgm`

Do this as a database admin before running app migrations.

### 3. Clone this repo

```bash
git clone https://github.com/rivr-social/rivr-group.git /opt/rivr-group
cd /opt/rivr-group
cp .env.example .env
```

### 4. Configure `.env`

Set the required values:

```bash
DATABASE_URL=postgresql://rivr:...@postgres:5432/rivr_group
AUTH_SECRET=<long-random-secret>
NEXTAUTH_URL=https://group.<your-domain>
NEXT_PUBLIC_BASE_URL=https://group.<your-domain>
INSTANCE_TYPE=group
INSTANCE_ID=<new-node-uuid>
INSTANCE_SLUG=<your-slug>
PRIMARY_AGENT_ID=<your-group-agent-uuid>
REGISTRY_URL=https://b.rivr.social/api/federation/registry
NODE_ADMIN_KEY=<strong-admin-key>
```

### 5. Install and build

```bash
pnpm install
pnpm build
```

### 6. Run migrations

```bash
pnpm db:migrate
```

### 7. Start the app

```bash
pnpm start
```

For Docker:

```bash
docker build -t rivr-group:latest .
docker run --env-file .env -p 3000:3000 rivr-group:latest
```

### 8. Verify

```bash
curl https://group.<your-domain>/api/health
curl -I https://group.<your-domain>/
```

The instance is correctly installed when:

- `/api/health` returns healthy
- `/` redirects to `/groups/<PRIMARY_AGENT_ID>`
- the group detail page loads
