/**
 * Tests for the groups/access API route.
 *
 * This route is a thin HTTP layer that validates inputs and delegates
 * to server actions from `@/app/actions/group-access`. The action
 * functions are mocked because they have their own dedicated tests;
 * here we verify HTTP semantics: status codes, error messages, and
 * correct parameter forwarding.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_FORBIDDEN,
} from "@/lib/http-status";

// =============================================================================
// Mocks — declared before module imports so vi.mock hoisting works correctly
// =============================================================================

const mockAuth = vi.fn();
const mockChallengeGroupAccess = vi.fn();
const mockCheckGroupMembership = vi.fn();
const mockRevokeGroupMembership = vi.fn();
const mockRenewGroupMembership = vi.fn();

vi.mock("@/auth", () => ({
  auth: () => mockAuth(),
}));

vi.mock("@/app/actions/group-access", () => ({
  challengeGroupAccess: (...args: unknown[]) =>
    mockChallengeGroupAccess(...args),
  checkGroupMembership: (...args: unknown[]) =>
    mockCheckGroupMembership(...args),
  revokeGroupMembership: (...args: unknown[]) =>
    mockRevokeGroupMembership(...args),
  renewGroupMembership: (...args: unknown[]) =>
    mockRenewGroupMembership(...args),
}));

// Import route handlers AFTER all mocks are in place
import { POST, GET, DELETE, PATCH } from "../route";

// =============================================================================
// Constants
// =============================================================================

const USER_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP_ID = "44444444-4444-4444-8444-444444444444";
const INVALID_UUID = "not-a-valid-uuid";
const BASE_URL = "http://localhost:3000/api/groups/access";
const EXPIRES_AT = "2099-12-31T23:59:59.000Z";

// =============================================================================
// Helpers
// =============================================================================

function createJsonRequest(method: string, body: unknown): Request {
  return new Request(BASE_URL, {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function createInvalidJsonRequest(method: string): Request {
  return new Request(BASE_URL, {
    method,
    body: "not valid json{{{",
    headers: { "Content-Type": "application/json" },
  });
}

// =============================================================================
// Test suite
// =============================================================================

describe("groups/access route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: USER_ID } });
  });

  // ===========================================================================
  // POST /api/groups/access
  // ===========================================================================

  describe("POST /api/groups/access", () => {
    it("returns 401 when not authenticated", async () => {
      mockAuth.mockResolvedValueOnce(null);

      const request = createJsonRequest("POST", {
        groupId: GROUP_ID,
        password: "secret",
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_UNAUTHORIZED);
      expect(body.error).toBe("Authentication required");
      expect(mockChallengeGroupAccess).not.toHaveBeenCalled();
    });

    it("returns 400 on invalid JSON body", async () => {
      const request = createInvalidJsonRequest("POST");
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toBe("Invalid request body");
      expect(mockChallengeGroupAccess).not.toHaveBeenCalled();
    });

    it("returns 400 on missing groupId", async () => {
      const request = createJsonRequest("POST", { password: "secret" });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toBe("Invalid or missing groupId");
      expect(mockChallengeGroupAccess).not.toHaveBeenCalled();
    });

    it("returns 400 on invalid groupId format", async () => {
      const request = createJsonRequest("POST", {
        groupId: INVALID_UUID,
        password: "secret",
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toBe("Invalid or missing groupId");
      expect(mockChallengeGroupAccess).not.toHaveBeenCalled();
    });

    it("returns 400 on missing password", async () => {
      const request = createJsonRequest("POST", { groupId: GROUP_ID });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toBe("Password is required");
      expect(mockChallengeGroupAccess).not.toHaveBeenCalled();
    });

    it("returns 403 when password is invalid", async () => {
      mockChallengeGroupAccess.mockResolvedValueOnce({
        success: false,
        error: "Invalid group password.",
      });

      const request = createJsonRequest("POST", {
        groupId: GROUP_ID,
        password: "wrongpassword",
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_FORBIDDEN);
      expect(body.error).toBe("Invalid group password.");
      expect(mockChallengeGroupAccess).toHaveBeenCalledWith(
        GROUP_ID,
        "wrongpassword"
      );
    });

    it("returns 400 on non-password challenge errors", async () => {
      mockChallengeGroupAccess.mockResolvedValueOnce({
        success: false,
        error: "Group not found.",
      });

      const request = createJsonRequest("POST", {
        groupId: GROUP_ID,
        password: "secret",
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toBe("Group not found.");
    });

    it("returns 200 with membershipId and expiresAt on success", async () => {
      mockChallengeGroupAccess.mockResolvedValueOnce({
        success: true,
        membershipId: MEMBERSHIP_ID,
        expiresAt: EXPIRES_AT,
      });

      const request = createJsonRequest("POST", {
        groupId: GROUP_ID,
        password: "correctpassword",
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.membershipId).toBe(MEMBERSHIP_ID);
      expect(body.expiresAt).toBe(EXPIRES_AT);
      expect(mockChallengeGroupAccess).toHaveBeenCalledWith(
        GROUP_ID,
        "correctpassword"
      );
    });
  });

  // ===========================================================================
  // GET /api/groups/access
  // ===========================================================================

  describe("GET /api/groups/access", () => {
    it("returns 401 when not authenticated", async () => {
      mockAuth.mockResolvedValueOnce(null);

      const request = new Request(`${BASE_URL}?groupId=${GROUP_ID}`, {
        method: "GET",
      });
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_UNAUTHORIZED);
      expect(body.error).toBe("Authentication required");
      expect(mockCheckGroupMembership).not.toHaveBeenCalled();
    });

    it("returns 400 when groupId query param is missing", async () => {
      const request = new Request(BASE_URL, { method: "GET" });
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toBe("Invalid or missing groupId");
      expect(mockCheckGroupMembership).not.toHaveBeenCalled();
    });

    it("returns 400 on invalid groupId query param", async () => {
      const request = new Request(`${BASE_URL}?groupId=${INVALID_UUID}`, {
        method: "GET",
      });
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toBe("Invalid or missing groupId");
      expect(mockCheckGroupMembership).not.toHaveBeenCalled();
    });

    it("returns 200 with membership check result", async () => {
      const membershipResult = {
        isMember: true,
        membershipId: MEMBERSHIP_ID,
        role: "member",
        expiresAt: EXPIRES_AT,
      };
      mockCheckGroupMembership.mockResolvedValueOnce(membershipResult);

      const request = new Request(`${BASE_URL}?groupId=${GROUP_ID}`, {
        method: "GET",
      });
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(membershipResult);
      expect(mockCheckGroupMembership).toHaveBeenCalledWith(GROUP_ID);
    });
  });

  // ===========================================================================
  // DELETE /api/groups/access
  // ===========================================================================

  describe("DELETE /api/groups/access", () => {
    it("returns 401 when not authenticated", async () => {
      mockAuth.mockResolvedValueOnce(null);

      const request = createJsonRequest("DELETE", {
        groupId: GROUP_ID,
        memberId: MEMBER_ID,
      });
      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_UNAUTHORIZED);
      expect(body.error).toBe("Authentication required");
      expect(mockRevokeGroupMembership).not.toHaveBeenCalled();
    });

    it("returns 400 on invalid JSON body", async () => {
      const request = createInvalidJsonRequest("DELETE");
      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toBe("Invalid request body");
      expect(mockRevokeGroupMembership).not.toHaveBeenCalled();
    });

    it("returns 400 on invalid groupId", async () => {
      const request = createJsonRequest("DELETE", {
        groupId: INVALID_UUID,
        memberId: MEMBER_ID,
      });
      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toBe("Invalid or missing groupId");
      expect(mockRevokeGroupMembership).not.toHaveBeenCalled();
    });

    it("returns 400 on invalid memberId", async () => {
      const request = createJsonRequest("DELETE", {
        groupId: GROUP_ID,
        memberId: INVALID_UUID,
      });
      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toBe("Invalid or missing memberId");
      expect(mockRevokeGroupMembership).not.toHaveBeenCalled();
    });

    it("returns 403 when not authorized to revoke", async () => {
      mockRevokeGroupMembership.mockResolvedValueOnce({
        success: false,
        error: "Not authorized to revoke this membership.",
      });

      const request = createJsonRequest("DELETE", {
        groupId: GROUP_ID,
        memberId: MEMBER_ID,
      });
      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_FORBIDDEN);
      expect(body.error).toBe("Not authorized to revoke this membership.");
      expect(mockRevokeGroupMembership).toHaveBeenCalledWith(
        GROUP_ID,
        MEMBER_ID
      );
    });

    it("returns 200 on successful revocation", async () => {
      mockRevokeGroupMembership.mockResolvedValueOnce({ success: true });

      const request = createJsonRequest("DELETE", {
        groupId: GROUP_ID,
        memberId: MEMBER_ID,
      });
      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockRevokeGroupMembership).toHaveBeenCalledWith(
        GROUP_ID,
        MEMBER_ID
      );
    });
  });

  // ===========================================================================
  // PATCH /api/groups/access
  // ===========================================================================

  describe("PATCH /api/groups/access", () => {
    it("returns 401 when not authenticated", async () => {
      mockAuth.mockResolvedValueOnce(null);

      const request = createJsonRequest("PATCH", { groupId: GROUP_ID });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_UNAUTHORIZED);
      expect(body.error).toBe("Authentication required");
      expect(mockRenewGroupMembership).not.toHaveBeenCalled();
    });

    it("returns 400 on invalid JSON body", async () => {
      const request = createInvalidJsonRequest("PATCH");
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toBe("Invalid request body");
      expect(mockRenewGroupMembership).not.toHaveBeenCalled();
    });

    it("returns 400 on invalid groupId", async () => {
      const request = createJsonRequest("PATCH", { groupId: INVALID_UUID });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toBe("Invalid or missing groupId");
      expect(mockRenewGroupMembership).not.toHaveBeenCalled();
    });

    it("returns 400 when renewal fails", async () => {
      mockRenewGroupMembership.mockResolvedValueOnce({
        success: false,
        error:
          "No prior membership found. Please use the group password to join.",
      });

      const request = createJsonRequest("PATCH", { groupId: GROUP_ID });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toBe(
        "No prior membership found. Please use the group password to join."
      );
      expect(mockRenewGroupMembership).toHaveBeenCalledWith(GROUP_ID);
    });

    it("returns 200 with renewed membership on success", async () => {
      mockRenewGroupMembership.mockResolvedValueOnce({
        success: true,
        membershipId: MEMBERSHIP_ID,
        expiresAt: EXPIRES_AT,
      });

      const request = createJsonRequest("PATCH", { groupId: GROUP_ID });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.membershipId).toBe(MEMBERSHIP_ID);
      expect(body.expiresAt).toBe(EXPIRES_AT);
      expect(mockRenewGroupMembership).toHaveBeenCalledWith(GROUP_ID);
    });
  });
});
