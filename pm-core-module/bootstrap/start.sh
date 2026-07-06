#!/bin/sh
# RIVR pm-core module container entrypoint.
# Mounted at /bootstrap/start.sh (read-only) and run as the container command.
#
# Responsibilities (mirrors the app image's docker/start.sh, plus the pm-core
# *_FILE secret convention):
#   1. Materialize file-based secrets into the env vars the app expects.
#   2. Run database migrations (fail-closed).
#   3. exec the Next.js server.
set -e

echo "=== RIVR module startup (instance=${INSTANCE_SLUG:-?} type=${INSTANCE_TYPE:-?}) ==="
echo "[info] user: $(whoami) (UID $(id -u))"

# --- DATABASE_URL: prefer full-URL secret, then *_FILE, then legacy password ---
if [ -n "${DATABASE_URL:-}" ]; then
  echo "[secrets] DATABASE_URL provided via environment"
elif [ -n "${DATABASE_URL_FILE:-}" ] && [ -f "${DATABASE_URL_FILE}" ]; then
  DATABASE_URL="$(cat "${DATABASE_URL_FILE}" | tr -d '[:space:]')"
  export DATABASE_URL
  echo "[secrets] DATABASE_URL loaded from ${DATABASE_URL_FILE}"
elif [ -f /run/secrets/db_url ]; then
  DATABASE_URL="$(cat /run/secrets/db_url | tr -d '[:space:]')"
  export DATABASE_URL
  echo "[secrets] DATABASE_URL loaded from /run/secrets/db_url"
elif [ -f /run/secrets/rivr_db_password ]; then
  POSTGRES_PASSWORD="$(cat /run/secrets/rivr_db_password)"
  DB_HOST="${DATABASE_HOST:-postgres}"; DB_PORT="${DATABASE_PORT:-5432}"
  DB_NAME="${DATABASE_NAME:-rivr}"; DB_USER="${DATABASE_USER:-rivr}"
  ENCODED_PW="$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$POSTGRES_PASSWORD")"
  export DATABASE_URL="postgresql://${DB_USER}:${ENCODED_PW}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
  echo "[secrets] DATABASE_URL built from rivr_db_password"
else
  echo "[secrets] ERROR: no database secret (db_url / DATABASE_URL_FILE / rivr_db_password)"; exit 1
fi

# --- REDIS_URL: prefer full-URL secret, then *_FILE ---
if [ -n "${REDIS_URL:-}" ]; then
  echo "[secrets] REDIS_URL provided via environment"
elif [ -n "${REDIS_URL_FILE:-}" ] && [ -f "${REDIS_URL_FILE}" ]; then
  REDIS_URL="$(cat "${REDIS_URL_FILE}" | tr -d '[:space:]')"
  export REDIS_URL
  echo "[secrets] REDIS_URL loaded from ${REDIS_URL_FILE}"
elif [ -f /run/secrets/redis_url ]; then
  REDIS_URL="$(cat /run/secrets/redis_url | tr -d '[:space:]')"
  export REDIS_URL
  echo "[secrets] REDIS_URL loaded from /run/secrets/redis_url"
fi

# --- AUTH_SECRET: env (from env_file) or file secret ---
if [ -n "${AUTH_SECRET:-}" ]; then
  export NEXTAUTH_SECRET="${AUTH_SECRET}"
  echo "[secrets] AUTH_SECRET provided via environment"
elif [ -f /run/secrets/rivr_auth_secret ]; then
  AUTH_SECRET="$(cat /run/secrets/rivr_auth_secret)"; export AUTH_SECRET
  export NEXTAUTH_SECRET="${AUTH_SECRET}"
  echo "[secrets] AUTH_SECRET loaded from /run/secrets/rivr_auth_secret"
else
  echo "[secrets] WARNING: AUTH_SECRET unset — auth will fail"
fi

# --- Optional: MinIO / federation admin key file secrets ---
[ -f /run/secrets/minio_root_password ] && { export MINIO_SECRET_KEY="$(cat /run/secrets/minio_root_password)"; export MINIO_ROOT_PASSWORD="$MINIO_SECRET_KEY"; }
[ -f /run/secrets/minio_root_user ]     && { export MINIO_ACCESS_KEY="$(cat /run/secrets/minio_root_user)"; export MINIO_ROOT_USER="$MINIO_ACCESS_KEY"; }
[ -f /run/secrets/rivr_federation_admin_key ] && export NODE_ADMIN_KEY="$(cat /run/secrets/rivr_federation_admin_key)"

# --- Migrations (fail-closed) ---
echo "[migrate] running database migrations..."
if node migrate-runner.cjs; then
  echo "[migrate] migrations OK"
else
  echo "[migrate] migrations FAILED (exit $?)"; exit 1
fi

# --- Serve ---
echo "[start] starting Next.js server..."
exec node server.js
