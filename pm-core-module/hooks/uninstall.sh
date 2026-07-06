#!/bin/sh
# RIVR module uninstall hook (identical across rivr-* modules) — removal marker.
# Does NOT drop the database or delete secrets (destructive; operator does that).
set -eu
MOD_ID="$(basename "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)")"
echo "[$MOD_ID:uninstall] instance=${INSTANCE_SLUG:-?} (data + secrets preserved)"
exit 0
