/**
 * Backfill script: encrypts any `user_connectors` access/refresh tokens that are
 * still stored as legacy plaintext (written before the secret-box envelope
 * existed).
 *
 * The secret-box module already phases plaintext out lazily — the next write to
 * a connector re-stores its token as ciphertext. This one-shot closes the
 * window immediately for rows that may not be rewritten soon. It is idempotent:
 * rows already in the `enc:v1:` envelope are skipped.
 *
 * Requires the same key material the app uses at runtime
 * (`CONNECTOR_ENCRYPTION_KEY`, or `AUTH_SECRET` fallback).
 *
 * Usage:
 *   npx tsx src/scripts/backfill-connector-encryption.ts
 *   npx tsx src/scripts/backfill-connector-encryption.ts --dry-run
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userConnectors } from "@/db/schema";
import { encryptSecret, isEncryptedSecret } from "@/lib/crypto/secret-box";

const isDryRun = process.argv.includes("--dry-run");

async function main() {
  const rows = await db
    .select({
      id: userConnectors.id,
      accessToken: userConnectors.accessToken,
      refreshToken: userConnectors.refreshToken,
    })
    .from(userConnectors);

  let scanned = 0;
  let updated = 0;
  let alreadyEncrypted = 0;

  for (const row of rows) {
    scanned += 1;
    const accessNeedsSeal = row.accessToken && !isEncryptedSecret(row.accessToken);
    const refreshNeedsSeal = row.refreshToken && !isEncryptedSecret(row.refreshToken);

    if (!accessNeedsSeal && !refreshNeedsSeal) {
      alreadyEncrypted += 1;
      continue;
    }

    const patch: { accessToken?: string | null; refreshToken?: string | null } = {};
    if (accessNeedsSeal) patch.accessToken = encryptSecret(row.accessToken);
    if (refreshNeedsSeal) patch.refreshToken = encryptSecret(row.refreshToken);

    if (isDryRun) {
      console.log(`[dry-run] would seal connector ${row.id} (${Object.keys(patch).join(", ")})`);
    } else {
      await db.update(userConnectors).set(patch).where(eq(userConnectors.id, row.id));
      console.log(`sealed connector ${row.id} (${Object.keys(patch).join(", ")})`);
    }
    updated += 1;
  }

  console.log(
    `\nDone. scanned=${scanned} sealed=${updated} alreadyEncrypted=${alreadyEncrypted}${isDryRun ? " (dry-run)" : ""}`,
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("backfill-connector-encryption failed:", error);
  process.exit(1);
});
