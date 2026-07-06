#!/bin/sh
# RIVR module install hook — validate prerequisites before first start.
# Identical across all rivr-* modules (module id derived from dir). Idempotent.
set -eu
MOD_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
MOD_ID="$(basename "$MOD_DIR")"
echo "[$MOD_ID:install] validating $MOD_DIR"

# 1. image MUST be pinned to an immutable image ID. The deploy script resolves
#    RIVR_IMAGE from image.lock (channel -> sha256: image ID) before invoking the
#    lifecycle. A floating tag (rivr:dev etc.) = drift risk and is rejected here.
case "${RIVR_IMAGE:-}" in
  sha256:*) echo "[$MOD_ID:install] image pinned: $RIVR_IMAGE" ;;
  "") echo "[$MOD_ID:install] ERROR: RIVR_IMAGE unset — deploy via tools/rivr-deploy.sh (resolves image ID from image.lock)"; exit 1 ;;
  *) echo "[$MOD_ID:install] ERROR: RIVR_IMAGE must be a sha256: image ID, got '$RIVR_IMAGE'"; exit 1 ;;
esac

# 2. required file-based secrets must exist
for s in rivr_db_password rivr_auth_secret rivr_federation_admin_key; do
  [ -s "$MOD_DIR/secrets/$s" ] || { echo "[$MOD_ID:install] ERROR: missing secret $s"; exit 1; }
done

echo "[$MOD_ID:install] OK"
exit 0
