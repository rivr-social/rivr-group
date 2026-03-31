/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Used to validate required environment variables before any request
 * is handled.
 *
 * Uses dynamic import because env.ts depends on Node.js `fs` module,
 * which is unavailable during the webpack edge bundling phase.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateEnv } = await import("@/lib/env");
    validateEnv();
  }
}
