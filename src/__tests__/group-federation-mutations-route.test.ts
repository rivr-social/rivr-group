import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateFederatedAssertion: vi.fn(),
  validateRemoteViewerToken: vi.fn(),
  resolveHomeInstance: vi.fn(),
  checkAuthorityForSession: vi.fn(),
}));

vi.mock("@/lib/federation/instance-config", () => ({
  getInstanceConfig: () => ({
    instanceId: "group-node",
    baseUrl: "https://group.example",
    primaryAgentId: "actor-1",
  }),
}));

vi.mock("@/lib/federation-remote-session", () => ({
  REMOTE_VIEWER_COOKIE_NAME: "rivr_remote_viewer",
  validateFederatedAssertion: mocks.validateFederatedAssertion,
  validateRemoteViewerToken: mocks.validateRemoteViewerToken,
}));

vi.mock("@/lib/federation/resolution", () => ({
  resolveHomeInstance: mocks.resolveHomeInstance,
}));

vi.mock("@/lib/federation-auth", () => ({
  authorizeFederationRequest: vi.fn(),
  bindAuthorizedFederationActor: vi.fn(),
}));

vi.mock("@/lib/federation/execution-context", () => ({
  runWithFederationExecutionContext: vi.fn(),
}));

vi.mock("@/lib/federation/domain-events", () => ({
  emitDomainEvent: vi.fn(),
  EVENT_TYPES: {},
}));

vi.mock("@/lib/federation/visitor-scope", () => ({
  requiredVisitorCapability: vi.fn(),
  resolveVisitorScope: vi.fn(),
  visitorCan: vi.fn(),
}));

vi.mock("@/lib/federation/authority-guard", () => ({
  AUTHORITY_GUARD_REASONS: {
    SUPERSEDED_BY_SUCCESSOR: "superseded_by_successor",
  },
  checkAuthorityForSession: mocks.checkAuthorityForSession,
}));

vi.mock("@/app/actions/interactions/social", () => ({
  toggleFollowAgent: vi.fn(),
  toggleJoinGroup: vi.fn(),
}));
vi.mock("@/app/actions/group-access", () => ({ applyMembershipRequestForActor: vi.fn() }));
vi.mock("@/lib/permissions", () => ({ isGroupMember: vi.fn() }));
vi.mock("@/app/actions/resource-creation/events", () => ({ createEventResource: vi.fn() }));
vi.mock("@/app/actions/resource-creation/offerings", () => ({ createOfferingResource: vi.fn() }));
vi.mock("@/app/actions/resource-creation/posts", () => ({ createPostResource: vi.fn() }));
vi.mock("@/app/actions/resource-creation/lifecycle", () => ({
  updateResource: vi.fn(),
  deleteResource: vi.fn(),
}));
vi.mock("@/lib/kg/autobot-kg-client", () => ({
  pushDocToKg: vi.fn(),
  queryKg: vi.fn(),
}));
vi.mock("@/db", () => ({ db: {} }));

import { POST } from "@/app/api/federation/mutations/route";

function buildRequest(): Request {
  return new Request("https://group.example/api/federation/mutations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-instance-id": "global-node",
      "x-instance-slug": "global",
      "x-remote-viewer-token": "viewer-token",
    },
    body: JSON.stringify({
      action: "follow",
      targetAgentId: "target-1",
      actor: {
        actorId: "actor-1",
        homeBaseUrl: "https://global.example",
        assertionType: "signed",
        assertion: "bad-assertion",
        issuedAt: "2026-06-25T00:00:00.000Z",
        expiresAt: "2026-06-25T00:05:00.000Z",
      },
    }),
  });
}

describe("group federation mutations route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateRemoteViewerToken.mockReturnValue({
      actorId: "actor-1",
      homeBaseUrl: "https://global.example",
      localInstanceId: "group-node",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    mocks.checkAuthorityForSession.mockResolvedValue({ allowed: true });
  });

  it("rejects an invalid actor assertion even when the remote viewer token matches", async () => {
    mocks.validateFederatedAssertion.mockReturnValue({
      valid: false,
      error: "Invalid assertion signature",
    });

    const response = await POST(buildRequest());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: "Invalid actor assertion: Invalid assertion signature",
    });
    expect(mocks.validateFederatedAssertion).toHaveBeenCalledWith({
      token: "bad-assertion",
      actorId: "actor-1",
      homeBaseUrl: "https://global.example",
      audienceBaseUrl: "https://group.example",
      issuedAt: "2026-06-25T00:00:00.000Z",
      expiresAt: "2026-06-25T00:05:00.000Z",
    });
    expect(mocks.resolveHomeInstance).not.toHaveBeenCalled();
  });
});
