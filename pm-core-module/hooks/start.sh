#!/bin/sh
# RIVR module start hook (identical across rivr-* modules). This is a HOST-side
# pm-core lifecycle hook — it only logs. The actual app migrate runs inside the
# container entrypoint (docker/start.sh -> node migrate-runner.cjs) on boot, and
# the container refuses to serve if it fails, so a passing health check proves
# migrations applied. Manual-migrate instances (e.g. Spirit) disable that path
# and the operator applies SQL by hand; deploy with --manual-migrate for those.
set -eu
MOD_ID="$(basename "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)")"
echo "[$MOD_ID:start] instance=${INSTANCE_SLUG:-?} domain=${DOMAIN:-?} db=${RIVR_DB_NAME:-?}"
exit 0
