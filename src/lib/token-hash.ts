/**
 * Token hashing for verification and password reset tokens.
 *
 * SHA-256 is sufficient because tokens are already high-entropy
 * (32 bytes of crypto.randomBytes). Hashing before storage means
 * a database read compromise doesn't leak usable tokens.
 */
import { createHash } from "crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
