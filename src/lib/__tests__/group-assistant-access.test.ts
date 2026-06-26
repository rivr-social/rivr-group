/**
 * Tests for `src/lib/group-assistant-access.ts`.
 *
 * The outward-facing AI policy is the security-critical part of the group
 * assistant: it must (a) never constrain owners/admins, (b) give members
 * member-scope, and (c) gate visitors/anonymous behind both the assistant's
 * public-chat flag AND the federated visitor policy, always at public scope.
 */

import { describe, expect, it } from "vitest";

import { resolveAssistantAccess } from "@/lib/group-assistant-access";
import {
  BASELINE_VISITOR_CAPABILITY,
  type VisitorScope,
} from "@/lib/federation/visitor-scope";

function scope(overrides: Partial<VisitorScope> = {}): VisitorScope {
  return {
    enabled: true,
    capabilities: [BASELINE_VISITOR_CAPABILITY],
    ttlMinutes: 30,
    recordVisits: true,
    ...overrides,
  };
}

describe("resolveAssistantAccess", () => {
  it("grants the owner full scope and exempts them from rate limiting", () => {
    const decision = resolveAssistantAccess({
      tier: "owner",
      publicChatEnabled: false,
      visitorScope: scope({ enabled: false }),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.kgScope).toBe("full");
    expect(decision.rateLimitExempt).toBe(true);
    expect(decision.reason).toBeNull();
  });

  it("grants an admin full scope and rate-limit exemption", () => {
    const decision = resolveAssistantAccess({
      tier: "admin",
      publicChatEnabled: false,
      visitorScope: scope({ enabled: false }),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.kgScope).toBe("full");
    expect(decision.rateLimitExempt).toBe(true);
  });

  it("grants a member member-scope but NOT rate-limit exemption", () => {
    const decision = resolveAssistantAccess({
      tier: "member",
      publicChatEnabled: false,
      visitorScope: scope({ enabled: false }),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.kgScope).toBe("member");
    expect(decision.rateLimitExempt).toBe(false);
  });

  it("denies a visitor when public chat is disabled", () => {
    const decision = resolveAssistantAccess({
      tier: "visitor",
      publicChatEnabled: false,
      visitorScope: scope(),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("public-chat-disabled");
    expect(decision.rateLimitExempt).toBe(false);
  });

  it("denies a visitor when public chat is on but visitors are disabled", () => {
    const decision = resolveAssistantAccess({
      tier: "visitor",
      publicChatEnabled: true,
      visitorScope: scope({ enabled: false }),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("visitors-disabled");
  });

  it("denies a visitor lacking the baseline read capability", () => {
    const decision = resolveAssistantAccess({
      tier: "visitor",
      publicChatEnabled: true,
      visitorScope: scope({ capabilities: [] }),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("missing-read-capability");
  });

  it("grants a visitor PUBLIC scope (never member/full) when fully permitted", () => {
    const decision = resolveAssistantAccess({
      tier: "visitor",
      publicChatEnabled: true,
      visitorScope: scope(),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.kgScope).toBe("public");
    expect(decision.rateLimitExempt).toBe(false);
  });

  it("treats anonymous callers like visitors (gated, public scope only)", () => {
    const denied = resolveAssistantAccess({
      tier: "anonymous",
      publicChatEnabled: false,
      visitorScope: scope(),
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("public-chat-disabled");

    const allowed = resolveAssistantAccess({
      tier: "anonymous",
      publicChatEnabled: true,
      visitorScope: scope(),
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.kgScope).toBe("public");
    expect(allowed.rateLimitExempt).toBe(false);
  });
});
