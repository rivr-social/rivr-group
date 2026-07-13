/**
 * Unit tests for the owner-routed home-signed actor assertion (buyer rail P0).
 *
 * Scope: pure crypto — mint with a real Ed25519 key pair (generateNodeKeyPair)
 * and exercise every verify branch. No database. The receiver's expectations
 * (audience, home-node, peer key) are passed directly, so these tests prove the
 * signature/audience/home/expiry/replay-window contract independent of the DB
 * orchestration (covered separately in owner-routed-actor.test.ts).
 */

import { describe, expect, it } from "vitest";

import { generateNodeKeyPair } from "@/lib/federation-crypto";
import {
  signOwnerRoutedActorAssertion,
  verifyOwnerRoutedActorAssertion,
  OwnerRoutedActorAssertionSigningError,
  type SignOwnerRoutedActorAssertionInput,
} from "@/lib/federation/owner-routed-actor-assertion";

const HOME_NODE_ID = "11111111-1111-1111-1111-111111111111";
const HOME_BASE_URL = "https://dev.rivr.social";
const AUDIENCE_BASE_URL = "https://bob.rivr.social";
const ACTOR_ID = "22222222-2222-2222-2222-222222222222";
const KID = `${HOME_BASE_URL}#dev`;
const FIXED_NOW = 1_760_000_000_000; // fixed clock (ms) so exp/iat are deterministic

function baseInput(
  overrides: Partial<SignOwnerRoutedActorAssertionInput> = {},
): SignOwnerRoutedActorAssertionInput {
  return {
    actorId: ACTOR_ID,
    homeNodeId: HOME_NODE_ID,
    homeBaseUrl: HOME_BASE_URL,
    audienceBaseUrl: AUDIENCE_BASE_URL,
    name: "Sally Seller",
    email: "sally@example.com",
    avatarUrl: "https://dev.rivr.social/avatar/sally.png",
    parentAgentId: null,
    now: FIXED_NOW,
    ...overrides,
  };
}

describe("owner-routed actor assertion — mint", () => {
  it("signs a well-formed envelope with kid, signature, iat/exp, and nonce", () => {
    const { privateKey } = generateNodeKeyPair();
    const signed = signOwnerRoutedActorAssertion(baseInput(), privateKey, KID);

    expect(signed.actorId).toBe(ACTOR_ID);
    expect(signed.homeNodeId).toBe(HOME_NODE_ID);
    expect(signed.audienceBaseUrl).toBe(AUDIENCE_BASE_URL);
    expect(signed.kid).toBe(KID);
    expect(typeof signed.signature).toBe("string");
    expect(signed.signature.length).toBeGreaterThan(0);
    expect(signed.iat).toBe(Math.floor(FIXED_NOW / 1000));
    expect(signed.exp).toBe(signed.iat + 120); // 2-minute default lifetime
    expect(typeof signed.nonce).toBe("string");
    expect(signed.name).toBe("Sally Seller");
  });

  it("clamps an over-long lifetime to the 5-minute max", () => {
    const { privateKey } = generateNodeKeyPair();
    const signed = signOwnerRoutedActorAssertion(
      baseInput({ lifetimeSec: 60 * 60 }),
      privateKey,
      KID,
    );
    expect(signed.exp - signed.iat).toBe(5 * 60);
  });

  it("throws when a required field is missing", () => {
    const { privateKey } = generateNodeKeyPair();
    expect(() =>
      signOwnerRoutedActorAssertion(baseInput({ actorId: "" }), privateKey, KID),
    ).toThrow(OwnerRoutedActorAssertionSigningError);
    expect(() =>
      signOwnerRoutedActorAssertion(baseInput({ homeNodeId: "" }), privateKey, KID),
    ).toThrow(OwnerRoutedActorAssertionSigningError);
  });
});

describe("owner-routed actor assertion — verify", () => {
  it("accepts a valid assertion signed by the peer key and returns claims", () => {
    const { publicKey, privateKey } = generateNodeKeyPair();
    const signed = signOwnerRoutedActorAssertion(baseInput(), privateKey, KID);

    const result = verifyOwnerRoutedActorAssertion({
      assertion: signed,
      expectedAudienceBaseUrl: AUDIENCE_BASE_URL,
      expectedHomeNodeId: HOME_NODE_ID,
      peerPublicKey: publicKey,
      now: FIXED_NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.actorId).toBe(ACTOR_ID);
      expect(result.claims.name).toBe("Sally Seller");
    }
  });

  it("accepts a trailing-slash / differently-cased audience by origin", () => {
    const { publicKey, privateKey } = generateNodeKeyPair();
    const signed = signOwnerRoutedActorAssertion(baseInput(), privateKey, KID);

    const result = verifyOwnerRoutedActorAssertion({
      assertion: signed,
      expectedAudienceBaseUrl: `${AUDIENCE_BASE_URL}/`,
      expectedHomeNodeId: HOME_NODE_ID,
      peerPublicKey: publicKey,
      now: FIXED_NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an expired assertion", () => {
    const { publicKey, privateKey } = generateNodeKeyPair();
    const signed = signOwnerRoutedActorAssertion(baseInput(), privateKey, KID);

    const result = verifyOwnerRoutedActorAssertion({
      assertion: signed,
      expectedAudienceBaseUrl: AUDIENCE_BASE_URL,
      expectedHomeNodeId: HOME_NODE_ID,
      peerPublicKey: publicKey,
      now: FIXED_NOW + 10 * 60 * 1000, // 10 min later — beyond exp + skew
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a not-yet-valid (future-dated) assertion", () => {
    const { publicKey, privateKey } = generateNodeKeyPair();
    const signed = signOwnerRoutedActorAssertion(baseInput(), privateKey, KID);

    const result = verifyOwnerRoutedActorAssertion({
      assertion: signed,
      expectedAudienceBaseUrl: AUDIENCE_BASE_URL,
      expectedHomeNodeId: HOME_NODE_ID,
      peerPublicKey: publicKey,
      now: FIXED_NOW - 10 * 60 * 1000, // 10 min before iat — beyond skew
    });
    expect(result).toEqual({ ok: false, reason: "not-yet-valid" });
  });

  it("rejects a wrong-audience assertion", () => {
    const { publicKey, privateKey } = generateNodeKeyPair();
    const signed = signOwnerRoutedActorAssertion(baseInput(), privateKey, KID);

    const result = verifyOwnerRoutedActorAssertion({
      assertion: signed,
      expectedAudienceBaseUrl: "https://spirit.rivr.social",
      expectedHomeNodeId: HOME_NODE_ID,
      peerPublicKey: publicKey,
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "audience-mismatch" });
  });

  it("rejects when the home node does not match the authenticated peer", () => {
    const { publicKey, privateKey } = generateNodeKeyPair();
    const signed = signOwnerRoutedActorAssertion(baseInput(), privateKey, KID);

    const result = verifyOwnerRoutedActorAssertion({
      assertion: signed,
      expectedAudienceBaseUrl: AUDIENCE_BASE_URL,
      expectedHomeNodeId: "99999999-9999-9999-9999-999999999999",
      peerPublicKey: publicKey,
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "home-node-mismatch" });
  });

  it("rejects an unsigned / tampered assertion (signature-invalid)", () => {
    const { publicKey, privateKey } = generateNodeKeyPair();
    const signed = signOwnerRoutedActorAssertion(baseInput(), privateKey, KID);
    // Tamper the actorId AFTER signing — the signature no longer matches.
    const tampered = { ...signed, actorId: "00000000-0000-0000-0000-000000000000" };

    const result = verifyOwnerRoutedActorAssertion({
      assertion: tampered,
      expectedAudienceBaseUrl: AUDIENCE_BASE_URL,
      expectedHomeNodeId: HOME_NODE_ID,
      peerPublicKey: publicKey,
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "signature-invalid" });
  });

  it("rejects an assertion signed by a DIFFERENT key (wrong peer)", () => {
    const { privateKey } = generateNodeKeyPair();
    const other = generateNodeKeyPair();
    const signed = signOwnerRoutedActorAssertion(baseInput(), privateKey, KID);

    const result = verifyOwnerRoutedActorAssertion({
      assertion: signed,
      expectedAudienceBaseUrl: AUDIENCE_BASE_URL,
      expectedHomeNodeId: HOME_NODE_ID,
      peerPublicKey: other.publicKey, // not the signer
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "signature-invalid" });
  });

  it("rejects when no peer key is available", () => {
    const { privateKey } = generateNodeKeyPair();
    const signed = signOwnerRoutedActorAssertion(baseInput(), privateKey, KID);

    const result = verifyOwnerRoutedActorAssertion({
      assertion: signed,
      expectedAudienceBaseUrl: AUDIENCE_BASE_URL,
      expectedHomeNodeId: HOME_NODE_ID,
      peerPublicKey: null,
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "no-peer-key" });
  });

  it("rejects a malformed (non-object / missing-field) payload", () => {
    const { publicKey } = generateNodeKeyPair();
    for (const bad of [null, undefined, 42, "x", {}, { actorId: "a" }]) {
      const result = verifyOwnerRoutedActorAssertion({
        assertion: bad,
        expectedAudienceBaseUrl: AUDIENCE_BASE_URL,
        expectedHomeNodeId: HOME_NODE_ID,
        peerPublicKey: publicKey,
        now: FIXED_NOW,
      });
      expect(result).toEqual({ ok: false, reason: "malformed" });
    }
  });
});
