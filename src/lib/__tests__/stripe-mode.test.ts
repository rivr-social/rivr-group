import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  eventMatchesRuntimeMode,
  getStripeRuntimeMode,
  stripeModeOfLivemode,
} from "@/lib/stripe-mode";

let savedSecretKey: string | undefined;

beforeEach(() => {
  savedSecretKey = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
});

afterEach(() => {
  if (savedSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = savedSecretKey;
});

describe("stripeModeOfLivemode", () => {
  it("maps Stripe's boolean livemode onto the mode vocabulary", () => {
    expect(stripeModeOfLivemode(true)).toBe("live");
    expect(stripeModeOfLivemode(false)).toBe("test");
  });
});

describe("getStripeRuntimeMode", () => {
  it("derives the mode from the secret key prefix", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_example";
    expect(getStripeRuntimeMode()).toBe("test");

    process.env.STRIPE_SECRET_KEY = "sk_live_example";
    expect(getStripeRuntimeMode()).toBe("live");
  });

  it("returns null when no key is set or the prefix is unrecognized", () => {
    expect(getStripeRuntimeMode()).toBeNull();

    process.env.STRIPE_SECRET_KEY = "rk_test_restricted";
    expect(getStripeRuntimeMode()).toBeNull();

    process.env.STRIPE_SECRET_KEY = "   ";
    expect(getStripeRuntimeMode()).toBeNull();
  });
});

describe("eventMatchesRuntimeMode", () => {
  it("accepts an event from the same environment", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_example";
    expect(eventMatchesRuntimeMode(false)).toBe(true);

    process.env.STRIPE_SECRET_KEY = "sk_live_example";
    expect(eventMatchesRuntimeMode(true)).toBe(true);
  });

  it("rejects an event from the other environment", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_example";
    expect(eventMatchesRuntimeMode(true)).toBe(false);

    process.env.STRIPE_SECRET_KEY = "sk_live_example";
    expect(eventMatchesRuntimeMode(false)).toBe(false);
  });

  it("rejects every event when the mode cannot be determined", () => {
    // Fail closed: an unconfigured or malformed key set must not process
    // events blindly just because it cannot judge them.
    expect(eventMatchesRuntimeMode(false)).toBe(false);
    expect(eventMatchesRuntimeMode(true)).toBe(false);
  });
});
