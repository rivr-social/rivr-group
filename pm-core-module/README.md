# rivr-group — pm-core module

RIVR **group** app type as a first-class pm-core module on the foundation
(Traefik+TLS, Postgres, file-based secrets, `pmdl_*` networks). Replaces the
bespoke `examples/rivr/docker-compose.rivr-*.yml` overlays for every
group-codebase instance.

## Why this exists (no drift, ever)

- **One module, many instances.** prod / beta / dev / test-a (and any
  group-codebase sovereign) all run THIS module. Everything that differs lives
  in the per-host `.env` (`DOMAIN`, `INSTANCE_SLUG`, `RIVR_DB_NAME`,
  `NEXTAUTH_URL`). There is no per-host source tree to drift.
- **Digest-pinned image.** `image.lock` pins `RIVR_IMAGE` to a `@sha256:` digest.
  The same digest runs on every host, byte-for-byte. No per-host `build:`.
- **Single source of truth.** `tools/rivr-image-build.sh` builds once, pushes,
  and writes the digest to `image.lock`. `tools/rivr-deploy.sh` deploys exactly
  that digest. `tools/rivr-drift-guard.sh` fails if any live container's running
  digest differs from `image.lock`.

## Files

| File | Purpose |
|---|---|
| `module.json` | Manifest (schema-validated). config → env mapping. |
| `docker-compose.yml` | Extends `_service-standard`; hardened; Traefik; secrets; external `pmdl_*` nets. |
| `image.lock` | The pinned digest + provenance SHA. **The anti-drift anchor.** |
| `hooks/` | install (validates digest+secrets), start, stop, health, uninstall. |
| `secrets-required.txt` | file-based docker secrets this module needs. |
| `.env.example` | per-instance template. |

## Operate (via the RIVR deploy protocol)

```bash
# build once from a pinned source SHA, push, write image.lock
tools/rivr-image-build.sh group <repos/group SHA>

# deploy the pinned digest to one instance (host + .env identify the instance)
tools/rivr-deploy.sh group --target dev

# verify nothing drifted
tools/rivr-drift-guard.sh
```

See `docs/active/pm-core-deploy-protocol.md` for the full protocol and gates.

## Secrets & real per-instance env (NOT in git)

This directory is the **canonical source of the rivr-group pm-core module** — the
same battle-tested config the live fleet runs. It is deployed by copying into a
pm-core / docker-lab tree at `modules/rivr-group/`, where the compose relative paths
`../../foundation` and `../../secrets` resolve.

Nothing secret is committed here:

- **Real per-instance env** lives host-only at
  `/opt/docker-lab/modules/rivr-group/instances/<slug>.env` and is git-ignored.
  The committed `instances/<slug>.env.EXAMPLE` files are sanitized templates
  (every credential replaced with a `__PLACEHOLDER_*__` token; non-secret parity
  config kept for reference). Provision a new instance by copying an EXAMPLE to
  `instances/<slug>.env` and filling the placeholders.
- **File-based docker secrets** (see `secrets-required.txt`) live host-only at
  `/opt/docker-lab/secrets/` and are mounted at `/run/secrets/*`. Never commit them.

### Entrypoint

`docker-compose.yml` **inlines** the startup script (secret materialization →
migrations → `node server.js`) as the container `command`, reproducing the live
overlay byte-for-byte for exact parity. `bootstrap/start.sh` is the same logic in
readable, standalone form (kept for maintainability / reference); if you switch to
the mounted-script form, wire it as the container entrypoint and mount this dir.
