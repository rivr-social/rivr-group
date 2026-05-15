#!/bin/sh
set -e

echo "=== RIVR Container Startup ==="
echo "[info] Running as user: $(whoami) (UID $(id -u))"

# Read secrets from Docker secret files into environment variables
# Supports both Docker Lab (rivr_*) and legacy (db_password, etc.) naming

# Database password → DATABASE_URL
if [ -n "$DATABASE_URL" ]; then
  echo "[secrets] DATABASE_URL provided via environment"
elif [ -f /run/secrets/rivr_db_password ]; then
  export POSTGRES_PASSWORD=$(cat /run/secrets/rivr_db_password)
  DB_HOST="${DATABASE_HOST:-postgres}"
  DB_PORT="${DATABASE_PORT:-5432}"
  DB_NAME="${DATABASE_NAME:-rivr}"
  DB_USER="${DATABASE_USER:-rivr}"
  # URL-encode the password (handles +, /, = from base64)
  ENCODED_PW=$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$POSTGRES_PASSWORD")
  export DATABASE_URL="postgresql://${DB_USER}:${ENCODED_PW}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
  echo "[secrets] Database credentials loaded from rivr_db_password"
elif [ -f /run/secrets/db_password ]; then
  export POSTGRES_PASSWORD=$(cat /run/secrets/db_password)
  DB_HOST="${DATABASE_HOST:-db}"
  export DATABASE_URL="postgresql://rivr:${POSTGRES_PASSWORD}@${DB_HOST}:5432/rivr"
  echo "[secrets] Database credentials loaded from db_password (legacy)"
fi

# Auth secret → AUTH_SECRET + NEXTAUTH_SECRET
if [ -f /run/secrets/rivr_auth_secret ]; then
  AUTH_VALUE=$(cat /run/secrets/rivr_auth_secret)
  export AUTH_SECRET="$AUTH_VALUE"
  export NEXTAUTH_SECRET="$AUTH_VALUE"
  echo "[secrets] Auth secret loaded from rivr_auth_secret"
elif [ -f /run/secrets/auth_secret ]; then
  AUTH_VALUE=$(cat /run/secrets/auth_secret)
  export AUTH_SECRET="$AUTH_VALUE"
  export NEXTAUTH_SECRET="$AUTH_VALUE"
  echo "[secrets] Auth secret loaded from auth_secret (legacy)"
fi

# MinIO secret → MINIO_SECRET_KEY + MINIO_ACCESS_KEY
if [ -f /run/secrets/minio_root_password ]; then
  export MINIO_SECRET_KEY=$(cat /run/secrets/minio_root_password)
  export MINIO_ROOT_PASSWORD=$(cat /run/secrets/minio_root_password)
  echo "[secrets] MinIO secret loaded from minio_root_password"
  # Access key from minio_root_user if available
  if [ -f /run/secrets/minio_root_user ]; then
    export MINIO_ACCESS_KEY=$(cat /run/secrets/minio_root_user)
    export MINIO_ROOT_USER=$(cat /run/secrets/minio_root_user)
  fi
elif [ -f /run/secrets/minio_secret ]; then
  export MINIO_SECRET_KEY=$(cat /run/secrets/minio_secret)
  echo "[secrets] MinIO secret loaded from minio_secret (legacy)"
fi

# SMTP password
if [ -f /run/secrets/smtp_password ]; then
  export SMTP_PASS=$(cat /run/secrets/smtp_password)
  echo "[secrets] SMTP password loaded"
fi

# Federation admin key → NODE_ADMIN_KEY
if [ -f /run/secrets/rivr_federation_admin_key ]; then
  export NODE_ADMIN_KEY=$(cat /run/secrets/rivr_federation_admin_key)
  echo "[secrets] Federation admin key loaded"
fi

# Matrix admin token → MATRIX_ADMIN_TOKEN
# Prefer dedicated admin token over registration shared secret
if [ -f /run/secrets/matrix_admin_token ]; then
  export MATRIX_ADMIN_TOKEN=$(cat /run/secrets/matrix_admin_token)
  echo "[secrets] Matrix admin token loaded"
elif [ -f /run/secrets/synapse_registration_shared_secret ]; then
  export MATRIX_ADMIN_TOKEN=$(cat /run/secrets/synapse_registration_shared_secret)
  echo "[secrets] Matrix admin token loaded from synapse shared secret (fallback)"
fi

# Redis password (construct URL if not already set)
if [ -z "$REDIS_URL" ] && [ -f /run/secrets/redis_password ]; then
  REDIS_PASS=$(cat /run/secrets/redis_password)
  REDIS_HOST="${REDIS_HOST:-redis}"
  REDIS_PORT_NUM="${REDIS_PORT:-6379}"
  ENCODED_REDIS_PW=$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$REDIS_PASS")
  export REDIS_URL="redis://:${ENCODED_REDIS_PW}@${REDIS_HOST}:${REDIS_PORT_NUM}"
  echo "[secrets] Redis URL constructed from redis_password"
fi

# Run database migrations using the plain-JS runner (no tsx needed)
echo "[migrate] Running database migrations..."
if node migrate-runner.cjs; then
  echo "[migrate] Migrations completed successfully"
else
  echo "[migrate] Migration failed with exit code $?"
  exit 1
fi

# Start Next.js server
echo "[start] Starting Next.js server..."
exec node server.js
