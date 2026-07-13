// src/lib/federation/owner-routed-actor.ts

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agents, nodes } from "@/db/schema";
import { ensureLocalNode, materializeFederatedActor } from "@/lib/federation";
import { resolveHomeInstance } from "@/lib/federation/resolution";
import {
  burnSsoNonce,
  type BurnSsoNonceResult,
} from "@/lib/federation/sso-nonce-store";
import {
  signOwnerRoutedActorAssertion,
  verifyOwnerRoutedActorAssertion,
  type SignedOwnerRoutedActorAssertion,
} from "@/lib/federation/owner-routed-actor-assertion";

/**
 * Orchestration for the owner-routed home-signed actor assertion (buyer rail,
 * open-issues P0). Two entry points:
 *
 * - {@link mintOwnerRoutedActorAssertion} (SENDER, the actor's home): resolve
 *   the actor's identity + the local node key and sign an assertion bound to the
 *   receiving instance. Only mints when the actor is locally homed here.
 * - {@link resolveOwnerRoutedActor} (RECEIVER, the resource's home): verify a
 *   presented assertion against the authenticated peer's registered key, burn
 *   its nonce (single-use), then materialize + bind the actor via the existing
 *   projection rail and return the receiver-local agent id.
 *
 * The receiver orchestration accepts injected dependencies so the full flow is
 * unit-testable without a database (mirrors how `verifySsoAssertion` injects its
 * key lookup).
 */

/** Namespaces owner-routed actor-assertion nonces so they never collide with SSO nonces. */
function nonceIssuer(homeBaseUrl: string): string {
  return `${homeBaseUrl.replace(/\/+$/, "")}#owner-routed-actor`;
}

// ─── Sender ───────────────────────────────────────────────────────────────────

/**
 * Mint a home-signed actor assertion for an owner-routed forward, or `null` when
 * the actor is not locally homed here (we must never sign for another home) or
 * the local node has no signing key. Returning `null` is a no-regression
 * fallback: the receiver then rejects an unbound actor exactly as today.
 *
 * @param actorId The acting user's LOCAL agent id on this (the home) instance.
 * @param audienceBaseUrl Base URL of the receiving instance (the resource home).
 */
export async function mintOwnerRoutedActorAssertion(
  actorId: string,
  audienceBaseUrl: string,
): Promise<SignedOwnerRoutedActorAssertion | null> {
  // Only the actor's HOME instance may sign for them. A projected/federated
  // actor homed elsewhere is skipped — we cannot vouch for another home.
  const home = await resolveHomeInstance(actorId).catch(() => null);
  if (!home || !home.isLocal) return null;

  const localNode = await ensureLocalNode().catch(() => null);
  if (!localNode?.privateKey || !localNode.id || !localNode.slug || !localNode.baseUrl) {
    return null;
  }

  const actor = await db.query.agents
    .findFirst({
      where: eq(agents.id, actorId),
      columns: { id: true, name: true, image: true, email: true, parentAgentId: true },
    })
    .catch(() => null);
  if (!actor) return null;

  const kid = `${localNode.baseUrl}#${localNode.slug}`;
  return signOwnerRoutedActorAssertion(
    {
      actorId,
      homeNodeId: localNode.id,
      homeBaseUrl: localNode.baseUrl,
      audienceBaseUrl,
      name: actor.name ?? undefined,
      email: actor.email ?? undefined,
      avatarUrl: actor.image ?? undefined,
      parentAgentId: actor.parentAgentId ?? null,
    },
    localNode.privateKey,
    kid,
  );
}

// ─── Receiver ─────────────────────────────────────────────────────────────────

/** Stable reason strings for a rejected owner-routed actor resolution. */
export type ResolveOwnerRoutedActorFailure =
  | "peer-no-public-key"
  | "actor-mismatch"
  | "replayed"
  | `assertion-${string}`;

export type ResolveOwnerRoutedActorResult =
  | { ok: true; localActorId: string }
  | { ok: false; reason: ResolveOwnerRoutedActorFailure };

/** Injectable dependencies for {@link resolveOwnerRoutedActor} (tests stub these). */
export interface ResolveOwnerRoutedActorDeps {
  loadPeer?: (
    peerNodeId: string,
  ) => Promise<{ publicKey: string | null; slug: string } | null>;
  burnNonce?: (input: {
    issuer: string;
    nonce: string;
    expUnixSec: number;
    actorId?: string | null;
  }) => Promise<BurnSsoNonceResult>;
  materialize?: (params: {
    peerNode: { id: string; slug: string };
    externalActorId: string;
    identity?: { name?: string | null; avatarUrl?: string | null; parentAgentId?: string | null };
  }) => Promise<string>;
  now?: number;
}

export interface ResolveOwnerRoutedActorParams {
  /** The authenticated sending peer's node id (from peer-secret auth). */
  peerNodeId: string;
  /** This receiver's base URL (audience binding). */
  audienceBaseUrl: string;
  /** The `actorId` from the mutation body — the assertion must vouch for it. */
  requestedActorId: string;
  /** The `actorAssertion` object from the mutation body. */
  assertion: unknown;
}

async function defaultLoadPeer(
  peerNodeId: string,
): Promise<{ publicKey: string | null; slug: string } | null> {
  const peer = await db.query.nodes
    .findFirst({
      where: eq(nodes.id, peerNodeId),
      columns: { publicKey: true, slug: true },
    })
    .catch(() => null);
  return peer ? { publicKey: peer.publicKey ?? null, slug: peer.slug } : null;
}

/**
 * Verify a presented owner-routed actor assertion and, on success, materialize +
 * bind the actor, returning the receiver-local agent id. Fails closed with a
 * stable reason on every rejection path.
 */
export async function resolveOwnerRoutedActor(
  params: ResolveOwnerRoutedActorParams,
  deps: ResolveOwnerRoutedActorDeps = {},
): Promise<ResolveOwnerRoutedActorResult> {
  const loadPeer = deps.loadPeer ?? defaultLoadPeer;
  const burnNonce = deps.burnNonce ?? burnSsoNonce;
  const materialize = deps.materialize ?? materializeFederatedActor;

  const peer = await loadPeer(params.peerNodeId);
  if (!peer || !peer.publicKey) {
    return { ok: false, reason: "peer-no-public-key" };
  }

  const verified = verifyOwnerRoutedActorAssertion({
    assertion: params.assertion,
    expectedAudienceBaseUrl: params.audienceBaseUrl,
    expectedHomeNodeId: params.peerNodeId,
    peerPublicKey: peer.publicKey,
    now: deps.now,
  });
  if (!verified.ok) {
    return { ok: false, reason: `assertion-${verified.reason}` };
  }

  const { claims } = verified;

  // The assertion must vouch for exactly the actor named in the mutation body.
  if (claims.actorId !== params.requestedActorId) {
    return { ok: false, reason: "actor-mismatch" };
  }

  // Single-use: burn AFTER a valid signature (so an attacker cannot pollute the
  // nonce table) and BEFORE materialization.
  const burned = await burnNonce({
    issuer: nonceIssuer(claims.homeBaseUrl),
    nonce: claims.nonce,
    expUnixSec: claims.exp,
    actorId: claims.actorId,
  });
  if (!burned.ok) {
    return { ok: false, reason: "replayed" };
  }

  const localActorId = await materialize({
    peerNode: { id: params.peerNodeId, slug: peer.slug },
    externalActorId: claims.actorId,
    identity: {
      name: claims.name ?? null,
      avatarUrl: claims.avatarUrl ?? null,
      parentAgentId: claims.parentAgentId ?? null,
    },
  });

  return { ok: true, localActorId };
}
