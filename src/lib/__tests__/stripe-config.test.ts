import { describe, expect, it } from "vitest";
import { validateStripeConfiguration } from "../env";

describe("validateStripeConfiguration", () => {
  it("accepts disabled and matched test configurations", () => {
    expect(validateStripeConfiguration({})).toBe("disabled");
    expect(validateStripeConfiguration({ secretKey: "sk_test_example", publishableKey: "pk_test_example" })).toBe("test");
  });

  it("rejects partial, malformed, and mixed-mode keys", () => {
    expect(() => validateStripeConfiguration({ secretKey: "sk_test_example" })).toThrow(/both/);
    expect(() => validateStripeConfiguration({ secretKey: "secret", publishableKey: "pk_test_example" })).toThrow(/recognized/);
    expect(() => validateStripeConfiguration({ secretKey: "sk_live_example", publishableKey: "pk_test_example" })).toThrow(/same test\/live mode/);
  });

  it("requires an explicit acknowledgement before enabling live mode", () => {
    expect(() => validateStripeConfiguration({ secretKey: "sk_live_example", publishableKey: "pk_live_example" })).toThrow(/STRIPE_LIVE_READY=true/);
    expect(validateStripeConfiguration({ secretKey: "sk_live_example", publishableKey: "pk_live_example", liveReady: "true" })).toBe("live");
  });
});
