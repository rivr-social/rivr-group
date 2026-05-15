#!/bin/sh
set -e

echo "=== RIVR Dev Container Startup ==="
echo "[info] Running as user: $(whoami) (UID $(id -u))"

# Read secrets from Docker secret files into environment variables
if [ -n "$DATABASE_URL" ]; then
  echo "[secrets] DATABASE_URL provided via environment"
elif [ -f /run/secrets/db_password ]; then
  export POSTGRES_PASSWORD=$(cat /run/secrets/db_password)
  export DATABASE_URL="postgresql://rivr:${POSTGRES_PASSWORD}@db:5432/rivr"
  echo "[secrets] Database credentials loaded from secret"
fi

if [ -f /run/secrets/auth_secret ]; then
  AUTH_VALUE=$(cat /run/secrets/auth_secret)
  export AUTH_SECRET="$AUTH_VALUE"
  export NEXTAUTH_SECRET="$AUTH_VALUE"
  echo "[secrets] Auth secret loaded"
fi

if [ -f /run/secrets/minio_secret ]; then
  export MINIO_SECRET_KEY=$(cat /run/secrets/minio_secret)
  echo "[secrets] MinIO secret loaded"
fi

if [ -f /run/secrets/smtp_password ]; then
  export SMTP_PASS=$(cat /run/secrets/smtp_password)
  echo "[secrets] SMTP password loaded"
fi

# Run database migrations
echo "[migrate] Running database migrations..."
if node migrate-runner.cjs; then
  echo "[migrate] Migrations completed successfully"
else
  echo "[migrate] Migration failed with exit code $?"
  exit 1
fi

# Start Next.js dev server with hot reload
echo "[start] Starting Next.js dev server..."
exec pnpm dev --hostname 0.0.0.0
