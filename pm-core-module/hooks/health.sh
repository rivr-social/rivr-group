#!/bin/sh
# RIVR module health hook (identical across rivr-* modules) — probe the running
# container's health endpoint.
set -eu
MOD_ID="$(basename "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)")"
C="${RIVR_CONTAINER:?RIVR_CONTAINER required (exact live container name; set by tools/rivr-deploy.sh)}"
if ! docker ps --filter "name=^${C}$" --format '{{.Names}}' | grep -q "$C"; then
  echo "[$MOD_ID:health] container $C not running"; exit 1
fi
if docker exec "$C" wget --no-verbose --tries=1 --spider http://localhost:3000/api/health >/dev/null 2>&1; then
  echo "[$MOD_ID:health] $C healthy"; exit 0
fi
echo "[$MOD_ID:health] $C health endpoint failed"; exit 1
