/**
 * Tests for the group-scoped faceted-FS API route (agent-hq/faceted-fs).
 *
 * The route is a thin HTTP layer: it resolves the viewer, enforces a
 * members-can-view gate on the group, then builds the faceted tree from the
 * group's doc Resources. DB access, auth resolution, and the permission engine
 * are mocked; the pure tree builder (parachute-doc) runs for real so we also
 * assert the shape it produces from real rows.
 *
 * Placed under src/lib/__tests__ (not src/app/api tests) so the default vitest
 * run picks it up: the config excludes api-dir tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (declared before importing the route so hoisting works) -----------

const mockGetActorId = vi.fn();
const mockIsGroupMember = vi.fn();
const mockCanManage = vi.fn();
const mockOrderBy = vi.fn();

vi.mock("@/lib/server-auth", () => ({
  getAuthenticatedActorId: () => mockGetActorId(),
}));

vi.mock("@/lib/permissions", () => ({
  isGroupMember: (...args: unknown[]) => mockIsGroupMember(...args),
  canManage: (...args: unknown[]) => mockCanManage(...args),
}));

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => mockOrderBy(),
        }),
      }),
    }),
  },
}));

import { GET } from "@/app/api/agent-hq/faceted-fs/route";
import type { NextRequest } from "next/server";

// --- Constants ---------------------------------------------------------------

const VIEWER_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const BASE = "http://localhost:3001/api/agent-hq/faceted-fs";

function makeRequest(groupId?: string): NextRequest {
  const url = groupId ? `${BASE}?groupId=${groupId}` : BASE;
  return { nextUrl: new URL(url) } as unknown as NextRequest;
}

const DOC_ROWS = [
  { id: "d1", name: "Spec", tags: [], metadata: { facetedTags: [["work", "projects"]] } },
  { id: "d2", name: "Loose", tags: [], metadata: {} },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActorId.mockResolvedValue(VIEWER_ID);
  mockIsGroupMember.mockResolvedValue({ isMember: true });
  mockCanManage.mockResolvedValue({ allowed: false });
  mockOrderBy.mockResolvedValue(DOC_ROWS);
});

describe("GET /api/agent-hq/faceted-fs (group vault gate)", () => {
  it("returns 401 for an anonymous viewer", async () => {
    mockGetActorId.mockResolvedValue(null);
    const res = await GET(makeRequest(GROUP_ID));
    expect(res.status).toBe(401);
  });

  it("returns 400 when groupId is missing", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
  });

  it("returns 403 for a non-member without manage rights", async () => {
    mockIsGroupMember.mockResolvedValue({ isMember: false });
    mockCanManage.mockResolvedValue({ allowed: false });
    const res = await GET(makeRequest(GROUP_ID));
    expect(res.status).toBe(403);
  });

  it("allows a member and returns the faceted tree", async () => {
    const res = await GET(makeRequest(GROUP_ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tree: Array<{ type: string; name: string }>;
      docCount: number;
    };
    expect(body.docCount).toBe(2);
    // d1 → work/projects facet; d2 → Untagged bucket.
    const topNames = body.tree.map((n) => n.name).sort();
    expect(topNames).toEqual(["Untagged", "work"]);
    expect(mockIsGroupMember).toHaveBeenCalledWith(VIEWER_ID, GROUP_ID);
  });

  it("allows a non-member admin (manage rights) to view the vault", async () => {
    mockIsGroupMember.mockResolvedValue({ isMember: false });
    mockCanManage.mockResolvedValue({ allowed: true });
    const res = await GET(makeRequest(GROUP_ID));
    expect(res.status).toBe(200);
    expect(mockCanManage).toHaveBeenCalledWith(VIEWER_ID, GROUP_ID, "agent");
  });
});
