/**
 * Federation status API route.
 *
 * Purpose:
 * - Returns local node identity metadata and federation health/operational metrics.
 *
 * Key exports:
 * - `GET`: Authenticated read endpoint for federation node status.
 *
 * Dependencies:
 * - `authorizeFederationRequest` for federation-level authentication/authorization.
 * - `ensureLocalNode` to resolve or provision the caller's local node context.
 * - `getFederationStatus` to compute status metrics for the resolved node.
 * - HTTP status constants from `@/lib/http-status`.
 */
import { NextResponse } from "next/server";
import { authorizeFederationRequest } from "@/lib/federation-auth";
import { ensureLocalNode, getFederationStatus } from "@/lib/federation";
import { STATUS_UNAUTHORIZED } from "@/lib/http-status";

/**
 * Returns federation status details for the authenticated local node.
 *
 * Auth requirements:
 * - Requires a valid federation authorization context. Unauthenticated requests
 *   receive `401 Unauthorized`.
 *
 * Rate limiting:
 * - No route-local limiter is applied in this handler; any throttling must be
 *   enforced upstream (edge/proxy) or in shared middleware.
 *
 * Error handling pattern:
 * - Authentication failures return a structured JSON error with a stable status code.
 * - Downstream failures (node resolution/status calculation) are intentionally allowed
 *   to surface to framework/global error handling.
 *
 * @param {Request} request - Incoming HTTP request used to evaluate federation auth.
 * @returns {Promise<NextResponse>} JSON response containing local node metadata and metrics.
 * @throws {Error} Propagates unexpected failures from federation services.
 * @example
 * ```ts
 * const response = await GET(new Request("https://example.com/api/federation/status"));
 * // => 200 with { node, metrics } when authorized, otherwise 401 with { error }
 * ```
 */
export async function GET(request: Request) {
  // Security gate: every federation endpoint must require signed/authenticated callers.
  const authorization = await authorizeFederationRequest(request);
  if (!authorization.authorized) {
    return NextResponse.json({ error: authorization.reason ?? "Authentication required" }, { status: STATUS_UNAUTHORIZED });
  }

  // Business rule: all status metrics are scoped to the caller's resolved local node.
  const localNode = await ensureLocalNode(authorization.actorId);
  const metrics = await getFederationStatus(localNode.id);

  return NextResponse.json({
    node: {
      id: localNode.id,
      slug: localNode.slug,
      role: localNode.role,
      baseUrl: localNode.baseUrl,
      isHosted: localNode.isHosted,
    },
    metrics,
  });
}
