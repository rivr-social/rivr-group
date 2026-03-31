/**
 * Lightweight client/server error reporting helper for Sentry ingestion.
 *
 * Key exports:
 * - `reportError`: best-effort error event delivery to Sentry using DSN from env.
 *
 * Dependencies:
 * - Global `URL`, `fetch`, and `crypto.randomUUID`.
 * - `process.env.NEXT_PUBLIC_SENTRY_DSN` for Sentry endpoint discovery.
 */
function parseSentryDsn(dsn: string): { endpoint: string; publicKey: string } | null {
  try {
    const parsed = new URL(dsn);
    const projectId = parsed.pathname.replace(/^\//, "");
    if (!projectId) return null;

    const [publicKey] = parsed.username.split(":");
    if (!publicKey) return null;

    const endpoint = `${parsed.protocol}//${parsed.host}/api/${projectId}/store/`;
    return { endpoint, publicKey };
  } catch {
    // Invalid DSN format should not break application control flow.
    return null;
  }
}

/**
 * Reports an application error to Sentry using a direct event payload.
 *
 * This is a best-effort path and intentionally suppresses transport failures.
 *
 * @param error - Any thrown value or error-like input to normalize into an `Error`.
 * @param context - Optional diagnostic key/value metadata attached to the event.
 * @returns Resolves when reporting attempt completes or is skipped.
 * @throws This function does not throw; it is safe to call inside failure paths.
 * @example
 * ```ts
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   await reportError(error, { feature: 'checkout', step: 'submit' });
 * }
 * ```
 */
export async function reportError(error: unknown, context?: Record<string, unknown>): Promise<void> {
  // If DSN is missing, monitoring is treated as disabled.
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;

  const parsed = parseSentryDsn(dsn);
  if (!parsed) return;

  // Normalize non-Error throwables so downstream serialization is consistent.
  const errorObj = error instanceof Error ? error : new Error(String(error));

  const payload = {
    // Sentry requires a 32-char hex event ID without dashes.
    event_id: crypto.randomUUID().replace(/-/g, ""),
    platform: "javascript",
    level: "error",
    timestamp: Date.now() / 1000,
    message: errorObj.message,
    exception: {
      values: [
        {
          type: errorObj.name,
          value: errorObj.message,
          stacktrace: errorObj.stack
            ? {
                frames: errorObj.stack
                  .split("\n")
                  .slice(1)
                  .map((line) => ({ filename: line.trim() })),
              }
            : undefined,
        },
      ],
    },
    extra: context ?? {},
  };

  try {
    // Include key and version in query per Sentry store API ingestion contract.
    await fetch(`${parsed.endpoint}?sentry_key=${parsed.publicKey}&sentry_version=7`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch {
    // do not throw from reporting path
  }
}
