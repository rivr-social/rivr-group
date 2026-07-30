// src/lib/__tests__/stripe-webhook-errors.test.ts
//
// The webhook's 200-vs-500 decision (audit M-6): only "this entity is not
// local" failures may be acknowledged; everything else must keep retrying.

import { describe, expect, it } from "vitest";

import { isForeignEntityError } from "@/lib/stripe-webhook-errors";

const FOREIGN_AGENT_ID = "84c86c99-1111-4111-8111-111111111111";

describe("isForeignEntityError", () => {
  it("matches the wallet/engine throw for a non-local agent", () => {
    // The exact live shape from lib/wallet.ts getOrCreateWallet.
    expect(
      isForeignEntityError(new Error(`Agent not found: ${FOREIGN_AGENT_ID}`)),
    ).toBe(true);
  });

  it("does not match a real processing failure", () => {
    expect(isForeignEntityError(new Error("Wallet balance insufficient"))).toBe(
      false,
    );
    expect(
      isForeignEntityError(new Error("connect ECONNREFUSED 127.0.0.1:5432")),
    ).toBe(false);
  });

  it("only matches at the START of the message, never mid-sentence", () => {
    // A settlement failure that merely quotes the phrase must still retry.
    expect(
      isForeignEntityError(
        new Error("Settlement failed because Agent not found: downstream"),
      ),
    ).toBe(false);
  });

  it("ignores non-Error throws", () => {
    expect(isForeignEntityError(`Agent not found: ${FOREIGN_AGENT_ID}`)).toBe(
      false,
    );
    expect(isForeignEntityError(null)).toBe(false);
    expect(isForeignEntityError(undefined)).toBe(false);
  });
});
