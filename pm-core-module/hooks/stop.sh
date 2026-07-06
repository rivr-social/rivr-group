#!/bin/sh
# RIVR module stop hook (identical across rivr-* modules).
set -eu
MOD_ID="$(basename "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)")"
echo "[$MOD_ID:stop] instance=${INSTANCE_SLUG:-?}"
exit 0
