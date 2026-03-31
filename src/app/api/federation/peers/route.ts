/**
 * Federation peer management API route.
 *
 * Purpose:
 * - Accepts authenticated requests to connect/register a peer node relationship.
 *
 * Key exports:
 * - `POST`: Creates or updates peer connectivity/trust linkage for the local node.
 *
 * Dependencies:
 * - `authorizeFederationRequest` for federation request authentication.
 * - `ensureLocalNode` for deriving the local node context from the authenticated actor.
 * - `connectPeer` for peer registration and trust-state updates.
 * - HTTP status constants from `@/lib/http-status`.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeFederationRequest } from "@/lib/federation-auth";
import { connectPeer, ensureLocalNode } from "@/lib/federation";
import type { NodeRole } from "@/db/schema";
import { STATUS_BAD_REQUEST, STATUS_UNAUTHORIZED } from "@/lib/http-status";

interface ConnectPeerInput {
  peerSlug: string;
  peerDisplayName: string;
  peerRole: NodeRole;
  peerBaseUrl: string;
  peerPublicKey: string;
}

/**
 * Connects a remote federation peer to the authenticated local node.
 *
 * Auth requirements:
 * - Requires federation authorization; unauthorized requests return `401`.
 *
 * Rate limiting:
 * - This route does not enforce a route-specific limiter. Operational protections
 *   should be provided by shared middleware or infrastructure if needed.
 *
 * Error handling pattern:
 * - Invalid JSON and missing required fields return `400` with explicit messages.
 * - Unexpected downstream errors are allowed to bubble to global error handling.
 *
 * Security considerations:
 * - The peer public key is mandatory and is required for cryptographic trust setup.
 *
 * @param {NextRequest} request - Incoming HTTP request containing peer connection payload.
 * @returns {Promise<NextResponse>} JSON response with local node, peer node, trust state, and peer secret.
 * @throws {Error} Propagates unexpected federation service failures.
 * @example
 * ```ts
 * const req = new Request("https://example.com/api/federation/peers", {
 *   method: "POST",
 *   body: JSON.stringify({
 *     peerSlug: "remote-a",
 *     peerDisplayName: "Remote A",
 *     peerRole: "hub",
 *     peerBaseUrl: "https://remote-a.example",
 *     peerPublicKey: "base64-encoded-key",
 *   }),
 * });
 * const response = await POST(req as NextRequest);
 * ```
 */
export async function POST(request: NextRequest) {
  // Security gate: all peer-linking operations require authenticated federation callers.
  const authorization = await authorizeFederationRequest(request);
  if (!authorization.authorized) {
    return NextResponse.json({ error: authorization.reason ?? "Authentication required" }, { status: STATUS_UNAUTHORIZED });
  }

  let body: ConnectPeerInput;
  try {
    body = (await request.json()) as ConnectPeerInput;
  } catch {
    // Consistent client error contract for malformed request payloads.
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: STATUS_BAD_REQUEST });
  }

  if (!body.peerSlug || !body.peerDisplayName || !body.peerRole || !body.peerBaseUrl || !body.peerPublicKey) {
    // Business rule: all peer identity and trust bootstrap fields are required.
    return NextResponse.json({ error: "Missing required peer fields (peerSlug, peerDisplayName, peerRole, peerBaseUrl, peerPublicKey)" }, { status: STATUS_BAD_REQUEST });
  }

  // Every peer relationship is anchored to the authenticated local node.
  const localNode = await ensureLocalNode(authorization.actorId);

  const result = await connectPeer({
    localNodeId: localNode.id,
    peerSlug: body.peerSlug,
    peerDisplayName: body.peerDisplayName,
    peerRole: body.peerRole,
    peerBaseUrl: body.peerBaseUrl,
    peerPublicKey: body.peerPublicKey,
  });

  return NextResponse.json({
    success: true,
    localNode: { id: localNode.id, slug: localNode.slug },
    peerNode: {
      id: result.peerNode.id,
      slug: result.peerNode.slug,
      role: result.peerNode.role,
      baseUrl: result.peerNode.baseUrl,
    },
    trustState: result.peer.trustState,
    peerSecret: result.peerSecret,
  });
}
