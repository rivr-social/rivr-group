# Peer outgoing SMTP settings

Ticket: #106

## What this is

A peer Rivr instance (person, group, locale, region) can now configure
its own outgoing SMTP credentials so transactional notifications it
owns — group broadcasts, login notices, billing receipts, etc. — are
delivered through its own SMTP (Gmail Workspace, Postmark, a custom
relay) instead of always being relayed through the global identity
authority.

## What this is NOT

**Federated-auth email is still pinned to global.** The following kinds
always route through `https://<global>/api/federation/email/send`
regardless of any peer SMTP configuration:

- `verification` (signup email verification)
- `password-reset`
- `recovery`

The peer cannot override this. Reason: federated auth lives on global
so password-reset and recovery flows keep working even when a peer is
offline, has misconfigured SMTP, or has rotated credentials.

This rule is enforced by `src/lib/mailer.ts` — see
`FEDERATED_AUTH_EMAIL_KINDS` / `isFederatedAuthEmailKind`.

## Routing summary

| Instance | Kind                          | Transport                                  |
|----------|-------------------------------|--------------------------------------------|
| Global   | any                           | local SMTP (`@/lib/email`)                 |
| Peer     | verification, password-reset, recovery | global relay (always)              |
| Peer     | transactional + peer SMTP enabled | peer's own SMTP (`peer-smtp-transport.ts`) |
| Peer     | transactional + no peer SMTP  | global relay (fallback)                    |

## How peers configure it

1. Sign in on the peer instance as an instance admin
   (`metadata.siteRole === "admin"` on the agent row).
2. Navigate to `/settings/outgoing-email`.
3. Fill in:
   - Host, port, secure (TLS) flag, username, from-address.
   - **Password secret reference** — either:
     - the name of a `process.env` variable (e.g. `PEER_SMTP_PASSWORD`)
     - or the absolute path of a Docker secret mount
       (e.g. `/run/secrets/peer_smtp_password`).
   - Toggle "Enable peer outgoing SMTP" on.
4. Save.
5. Click "Send test email" to verify the SMTP handshake and confirm
   credentials work end-to-end. The last test outcome is persisted to
   `peer_smtp_config.last_test_{at,status,error}`.

If peer SMTP is removed or disabled, the mailer falls back to the
global federation relay for transactional kinds.

## Security contract

- `peer_smtp_config.password_secret_ref` stores a **reference only** —
  never the plaintext password.
- Plaintext passwords are dereferenced at send time by
  `getPeerSmtpConfig()` in `src/lib/federation/peer-smtp.ts`.
- The resolved password lives in-process only (attached to the
  nodemailer transport). It is never logged, echoed in an API
  response, or persisted.
- The admin API rejects anything that looks like a plaintext password
  sneaking into the reference field (contains whitespace or `@`).

## Host / container operator responsibilities

To provide the password that the secret reference points at, one of:

- Set an env var on the peer container. E.g. in the peer's docker-compose:

  ```yaml
  services:
    rivr-peer:
      environment:
        - PEER_SMTP_PASSWORD=<your smtp app password>
  ```

  …and configure the reference in the admin UI as `PEER_SMTP_PASSWORD`.

- Or mount a Docker secret:

  ```yaml
  services:
    rivr-peer:
      secrets:
        - peer_smtp_password
  secrets:
    peer_smtp_password:
      file: ./secrets/peer_smtp_password.txt
  ```

  …and configure the reference as `/run/secrets/peer_smtp_password`.

## API surface

All routes are admin-gated via `metadata.siteRole === "admin"`.

- `GET /api/admin/smtp-config` — current config (no resolved password)
- `POST /api/admin/smtp-config` — upsert
- `POST /api/admin/smtp-config/test` — run handshake + optional test send
- `DELETE /api/admin/smtp-config` — remove + fall back to relay

## Related files

- `src/lib/mailer.ts` — per-kind routing
- `src/lib/federation/peer-smtp.ts` — config loader + secret resolver
- `src/lib/federation/peer-smtp-transport.ts` — nodemailer wrapper
- `src/app/api/admin/smtp-config/route.ts` — GET/POST/DELETE
- `src/app/api/admin/smtp-config/test/route.ts` — POST test send
- `src/app/settings/outgoing-email/*` — admin UI
- `src/db/migrations/0039_peer_smtp_config.sql` — schema migration
