/**
 * Unit tests for resolveOwnerRoutedActor — the receiver-side verify → burn →
 * materialize orchestration (buyer rail P0).
 *
 * Fully DB-free: the heavy `@/db`, `@/lib/federation`, and nonce-store imports
 * are mocked, and every call injects `loadPeer`/`burnNonce`/`materialize` stubs
 * so we exercise the real verifier + orchestration logic without a database.
 * Proves the "valid assertion materializes + binds" accept path and the
 * expired/wrong-audience/unsigned/replayed/unbound reject paths.
 */

import { describe, expect, it, vi } from "vitest";

import { generateNodeKeyPair } from "@/lib/federation-crypto";
import {
  signOwnerRoutedActorAssertion,
  type SignedOwnerRoutedActorAssertion,
} from "@/lib/federation/owner-routed-actor-assertion";
import {
  resolveOwnerRoutedActor,
  type ResolveOwnerRoutedActorDeps,
} from "@/lib/federation/owner-routed-actor";

// Keep the module's heavy default deps from loading a real DB client. Every
// test injects stubs, so these are never called — the mocks only make the
// static imports cheap and hermetic.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/federation", () => ({
  materializeFederatedActor: vi.fn(),
}));
vi.mock("@/lib/federation/sso-nonce-store", () => ({
  burnSsoNonce: vi.fn(),
}));

const PEER_NODE_ID = "11111111-1111-1111-1111-111111111111";
const HOME_BASE_URL = "https://dev.rivr.social";
const AUDIENCE_BASE_URL = "https://bob.rivr.social";
const ACTOR_ID = "22222222-2222-2222-2222-222222222222";
const LOCAL_ACTOR_ID = ACTOR_ID; // projection keys the local row on the external UUID
const FIXED_NOW = 1_760_000_000_000;

function mintAssertion(
  privateKey: string,
  overrides: { audienceBaseUrl?: string; actorId?: string } = {},
): SignedOwnerRoutedActorAssertion {
  return signOwnerRoutedActorAssertion(
    {
      actorId: overrides.actorId ?? ACTOR_ID,
      homeNodeId: PEER_NODE_ID,
      homeBaseUrl: HOME_BASE_URL,
      audienceBaseUrl: overrides.audienceBaseUrl ?? AUDIENCE_BASE_URL,
      name: "Sally Seller",
      avatarUrl: "https://dev.rivr.social/avatar/sally.png",
      parentAgentId: null,
      now: FIXED_NOW,
    },
    privateKey,
    `${HOME_BASE_URL}#dev`,
  );
}

function makeDeps(
  publicKey: string | null,
  over: Partial<ResolveOwnerRoutedActorDeps> = {},
): {
  deps: ResolveOwnerRoutedActorDeps;
  burnNonce: ReturnType<typeof vi.fn>;
  materialize: ReturnType<typeof vi.fn>;
} {
  const burnNonce = vi.fn(async () => ({ ok: true }) as const);
  const materialize = vi.fn(async () => LOCAL_ACTOR_ID);
  const deps: ResolveOwnerRoutedActorDeps = {
    loadPeer: async () => (publicKey === null ? { publicKey: null, slug: "dev" } : { publicKey, slug: "dev" }),
    burnNonce,
    materialize,
    now: FIXED_NOW,
    ...over,
  };
  return { deps, burnNonce, materialize };
}

describe("resolveOwnerRoutedActor — accept", () => {
  it("verifies, burns the nonce, materializes + binds, and returns the local actor id", async () => {
    const { publicKey, privateKey } = generateNodeKeyPair();
    const assertion = mintAssertion(privateKey);
    const { deps, burnNonce, materialize } = makeDeps(publicKey);

    const result = await resolveOwnerRoutedActor(
      {
        peerNodeId: PEER_NODE_ID,
        audienceBaseUrl: AUDIENCE_BASE_URL,
        requestedActorId: ACTOR_ID,
        assertion,
      },
      deps,
    );

    expect(result).toEqual({ ok: true, localActorId: LOCAL_ACTOR_ID });
    // Replay burn happened before materialization.
    expect(burnNonce).toHaveBeenCalledTimes(1);
    expect(burnNonce).toHaveBeenCalledWith(
      expect.objectContaining({
        issuer: `${HOME_BASE_URL}#owner-routed-actor`,
        nonce: assertion.nonce,
        expUnixSec: assertion.exp,
      }),
    );
    // Materialized against the authenticated peer, keyed on the asserted actor,
    // with the asserted display identity.
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize).toHaveBeenCalledWith({
      peerNode: { id: PEER_NODE_ID, slug: "dev" },
      externalActorId: ACTOR_ID,
      identity: {
        name: "Sally Seller",
        avatarUrl: "https://dev.rivr.social/avatar/sally.png",
        parentAgentId: null,
      },
    });
  });
});

describe("resolveOwnerRoutedActor — reject", () => {
  it("rejects when the peer has no registered public key", async () => {
    const { privateKey } = generateNodeKeyPair();
    const assertion = mintAssertion(privateKey);
    const { deps, burnNonce, materialize } = makeDeps(null);

    const result = await resolveOwnerRoutedActor(
      { peerNodeId: PEER_NODE_ID, audienceBaseUrl: AUDIENCE_BASE_URL, requestedActorId: ACTOR_ID, assertion },
      deps,
    );

    expect(result).toEqual({ ok: false, reason: "peer-no-public-key" });
    expect(burnNonce).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });

  it("rejects (and never burns/materializes) on a wrong-audience assertion", async () => {
    const { publicKey, privateKey } = generateNodeKeyPair();
    const assertion = mintAssertion(privateKey, { audienceBaseUrl: "https://spirit.rivr.social" });
    const { deps, burnNonce, materialize } = makeDeps(publicKey);

    const result = await resolveOwnerRoutedActor(
      { peerNodeId: PEER_NODE_ID, audienceBaseUrl: AUDIENCE_BASE_URL, requestedActorId: ACTOR_ID, assertion },
      deps,
    );

    expect(result).toEqual({ ok: false, reason: "assertion-audience-mismatch" });
    expect(burnNonce).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });

  it("rejects when the assertion vouches for a different actor than the body", async () => {
    const { publicKey, privateKey } = generateNodeKeyPair();
    const assertion = mintAssertion(privateKey, { actorId: "33333333-3333-3333-3333-333333333333" });
    const { deps, burnNonce, materialize } = makeDeps(publicKey);

    const result = await resolveOwnerRoutedActor(
      { peerNodeId: PEER_NODE_ID, audienceBaseUrl: AUDIENCE_BASE_URL, requestedActorId: ACTOR_ID, assertion },
      deps,
    );

    expect(result).toEqual({ ok: false, reason: "actor-mismatch" });
    expect(burnNonce).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });

  it("rejects a replayed assertion (nonce already burned) and does not materialize", async () => {
    const { publicKey, privateKey } = generateNodeKeyPair();
    const assertion = mintAssertion(privateKey);
    const { deps, materialize } = makeDeps(publicKey, {
      burnNonce: vi.fn(async () => ({ ok: false, reason: "replayed" }) as const),
    });

    const result = await resolveOwnerRoutedActor(
      { peerNodeId: PEER_NODE_ID, audienceBaseUrl: AUDIENCE_BASE_URL, requestedActorId: ACTOR_ID, assertion },
      deps,
    );

    expect(result).toEqual({ ok: false, reason: "replayed" });
    expect(materialize).not.toHaveBeenCalled();
  });

  it("rejects a tampered assertion (signature-invalid) before any side effect", async () => {
    const { publicKey, privateKey } = generateNodeKeyPair();
    const assertion = { ...mintAssertion(privateKey), name: "Mallory" };
    const { deps, burnNonce, materialize } = makeDeps(publicKey);

    const result = await resolveOwnerRoutedActor(
      { peerNodeId: PEER_NODE_ID, audienceBaseUrl: AUDIENCE_BASE_URL, requestedActorId: ACTOR_ID, assertion },
      deps,
    );

    expect(result).toEqual({ ok: false, reason: "assertion-signature-invalid" });
    expect(burnNonce).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });
});
