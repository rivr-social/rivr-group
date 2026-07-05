/**
 * GET /api/resources/[id]/access
 *
 * The single per-resource gated endpoint that implements the audit's
 * verified-principal access model. A request is served when the caller is:
 *   (a) a verified principal (auth() session or peer-bound federation actor)
 *       WITH an explicit grant (owner / grant edge / role), OR
 *   (c) presenting a settled x402 payment for a record that opted into x402.
 *
 * x402 is OFF for every resource by default. The payment path only exists when
 * the resource owner explicitly enabled it (resources.metadata.x402, set from
 * the documents/filesystem view). When x402 is off and the principal lacks a
 * grant, the answer is a plain 403 — there is no way to pay your way in.
 *
 * Payment handshake (when the record opted in and the principal has no grant):
 *   - No `X-PAYMENT` header  -> 402 + PaymentRequirements body.
 *   - `X-PAYMENT` present     -> facilitator verify (non-mutating); on success
 *                                facilitator settle (onchain); persist an
 *                                idempotent RIVR receipt; 200 + `X-PAYMENT-RESPONSE`.
 *   - An authenticated principal who already has a receipt for this resource is
 *     re-granted access without being charged again.
 */

import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { resources } from "@/db/schema";
import { canView } from "@/lib/permissions";
import { authorizeFederationRequest } from "@/lib/federation-auth";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  STATUS_OK,
  STATUS_FORBIDDEN,
  STATUS_NOT_FOUND,
  STATUS_TOO_MANY_REQUESTS,
  STATUS_SERVICE_UNAVAILABLE,
} from "@/lib/http-status";
import {
  resolveResourceX402Policy,
  buildPaymentRequirements,
} from "@/lib/x402/policy";
import { resolveProtocolVersion } from "@/lib/x402/config";
import {
  decodePaymentHeader,
  encodePaymentResponseHeader,
  verifyPayment,
  settlePayment,
  X402FacilitatorError,
} from "@/lib/x402/facilitator";
import {
  recordX402Receipt,
  findX402ReceiptForPrincipal,
} from "@/lib/x402/receipt";

/** HTTP 402 Payment Required — not defined in the shared status module. */
const STATUS_PAYMENT_REQUIRED = 402;

/** Strict UUID v1–v5 guard for the path id. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Resolves the calling principal: an authenticated session user, or a
 * peer-bound federation actor. Returns `{ actorId: null }` for an
 * unauthenticated caller (still allowed to take the payment path).
 */
async function resolvePrincipal(request: Request): Promise<{ actorId: string | null }> {
  const session = await auth();
  if (session?.user?.id) {
    return { actorId: session.user.id };
  }
  const federation = await authorizeFederationRequest(request);
  if (federation.authorized && federation.actorId) {
    return { actorId: federation.actorId };
  }
  return { actorId: null };
}

/** Shape returned on a successful (granted or paid) access. */
function buildAccessPayload(resource: {
  id: string;
  name: string;
  type: string | null;
  description: string | null;
  content: string | null;
  metadata: unknown;
}) {
  return {
    id: resource.id,
    name: resource.name,
    type: resource.type,
    description: resource.description,
    content: resource.content,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: "Resource not found." }, { status: STATUS_NOT_FOUND });
  }

  // Per-IP/identity burst guard keyed on the resource so a paid endpoint can't
  // be hammered. FEDERATION tier matches other machine-facing read endpoints.
  const rateKey = request.headers.get("x-peer-slug") ?? "anon";
  const rate = await checkRateLimit("FEDERATION", `resource-access:${rateKey}:${id}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded." },
      { status: STATUS_TOO_MANY_REQUESTS, headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) } },
    );
  }

  const [resource] = await db
    .select({
      id: resources.id,
      name: resources.name,
      type: resources.type,
      description: resources.description,
      content: resources.content,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(and(eq(resources.id, id), isNull(resources.deletedAt)))
    .limit(1);

  if (!resource) {
    return NextResponse.json({ error: "Resource not found." }, { status: STATUS_NOT_FOUND });
  }

  const metadata = (resource.metadata ?? null) as Record<string, unknown> | null;
  const { actorId } = await resolvePrincipal(request);

  // Path (a): verified principal WITH an explicit grant — served immediately.
  if (actorId) {
    const grant = await canView(actorId, resource.id, "resource");
    if (grant.allowed) {
      return NextResponse.json(
        { success: true, access: "grant", via: grant.via ?? grant.reason, data: buildAccessPayload(resource) },
        { status: STATUS_OK },
      );
    }
  }

  // Path (c): x402. Only exists when the record explicitly opted in.
  const policy = resolveResourceX402Policy(metadata);
  if (!policy) {
    // x402 OFF (default) and no grant: there is no payment path in.
    return NextResponse.json(
      { success: false, error: "You do not have access to this resource." },
      { status: STATUS_FORBIDDEN },
    );
  }

  // Re-grant: an authenticated principal who already paid is not charged again.
  if (actorId) {
    const existing = await findX402ReceiptForPrincipal(resource.id, actorId);
    if (existing) {
      return NextResponse.json(
        { success: true, access: "x402-receipt", receiptId: existing.id, data: buildAccessPayload(resource) },
        { status: STATUS_OK },
      );
    }
  }

  const config = getInstanceConfig();
  const resourceUrl = `${config.baseUrl}/api/resources/${resource.id}/access`;
  const requirements = buildPaymentRequirements(policy, resourceUrl);

  const payment = decodePaymentHeader(request.headers.get("x-payment"));
  if (!payment) {
    // Advertise what the caller must pay.
    return NextResponse.json(
      { x402Version: resolveProtocolVersion(), accepts: [requirements], error: "Payment required." },
      { status: STATUS_PAYMENT_REQUIRED },
    );
  }

  try {
    // Verify is non-mutating: confirm the payload satisfies requirements before
    // we ask the facilitator to move funds.
    const verification = await verifyPayment(payment, requirements);
    if (!verification.isValid) {
      return NextResponse.json(
        {
          x402Version: resolveProtocolVersion(),
          accepts: [requirements],
          error: verification.invalidReason ?? "Payment verification failed.",
        },
        { status: STATUS_PAYMENT_REQUIRED },
      );
    }

    // Settle: the facilitator performs the onchain transfer to policy.payTo.
    const settlement = await settlePayment(payment, requirements);
    if (!settlement.success || !settlement.transaction) {
      return NextResponse.json(
        {
          x402Version: resolveProtocolVersion(),
          accepts: [requirements],
          error: settlement.errorReason ?? "Payment settlement failed.",
        },
        { status: STATUS_PAYMENT_REQUIRED },
      );
    }

    // Persist RIVR's own receipt. Idempotent on the settlement tx hash, so a
    // replayed X-PAYMENT cannot unlock twice.
    const receipt = await recordX402Receipt({
      resourceId: resource.id,
      payerAgentId: actorId,
      payerAddress: settlement.payer ?? verification.payer ?? null,
      settlementTx: settlement.transaction,
      network: settlement.network ?? policy.network,
      asset: policy.asset,
      amountCents: policy.priceCents,
      payTo: policy.payTo,
      metadata: { scheme: requirements.scheme },
    });

    return NextResponse.json(
      { success: true, access: "x402-paid", receiptId: receipt.id, data: buildAccessPayload(resource) },
      {
        status: STATUS_OK,
        headers: { "X-PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement) },
      },
    );
  } catch (error) {
    if (error instanceof X402FacilitatorError && error.notConfigured) {
      return NextResponse.json(
        { success: false, error: "Paid access is temporarily unavailable." },
        { status: STATUS_SERVICE_UNAVAILABLE },
      );
    }
    console.error("[resources/access] x402 payment handling failed:", error);
    return NextResponse.json(
      { x402Version: resolveProtocolVersion(), accepts: [requirements], error: "Payment processing error." },
      { status: STATUS_PAYMENT_REQUIRED },
    );
  }
}
