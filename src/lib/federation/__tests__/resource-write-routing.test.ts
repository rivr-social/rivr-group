import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Routing-decision coverage for `updateResource` / `deleteResource`
 * (src/app/actions/resource-creation/lifecycle.ts).
 *
 * Defect class fixed 2026-08-24 (found on rivr-global, present here too): a
 * resource authored NATIVELY on this instance by a sovereign-merged member
 * (owner agent homed elsewhere — e.g. the steward, homed on his person
 * instance, posting on this group instance) was owner-routed: the delete
 * branch treated "owner is remote-homed" as "this row is a mirror", and the
 * facade owner-routed the native update/delete transaction itself. The
 * discriminator is the RESOURCE row: `metadata.externalEntityId` present =
 * mirror (forward, keyed on the home id); absent = native (execute locally).
 *
 * Pure decision test — everything below the unit is mocked; no Postgres.
 * Lives under lib/federation because the actions __tests__ trees run only
 * under the DB vitest config.
 */

const mocks = vi.hoisted(() => ({
  executeResourceAnchored: vi.fn(),
  resolveAuthenticatedUserId: vi.fn(),
  canModifyResource: vi.fn(),
  routeWrite: vi.fn(),
  resolveHomeInstance: vi.fn(),
  updateFacade: vi.fn(),
  emitDomainEvent: vi.fn(),
  rateLimit: vi.fn(),
  dbUpdate: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/db/schema", () => ({ agents: {}, ledger: {}, resources: {} }));
vi.mock("@/db", () => ({
  db: {
    update: mocks.dbUpdate.mockReturnValue({ set: () => ({ where: async () => undefined }) }),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ update: () => ({ set: () => ({ where: async () => undefined }) }), insert: () => ({ values: async () => undefined }) })),
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })),
  },
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn(), eq: vi.fn(), sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  RATE_LIMITS: { SOCIAL: { limit: 30, windowMs: 60_000 } },
}));
vi.mock("@/lib/billing", () => ({ hasEntitlement: vi.fn(async () => true) }));
vi.mock("@/lib/ai", () => ({ embedResource: vi.fn(), scheduleEmbedding: vi.fn() }));
vi.mock("@/lib/murmurations", () => ({ syncMurmurationsProfilesForActor: vi.fn() }));
vi.mock("@/app/actions/resource-creation/helpers", () => ({
  resolveAuthenticatedUserId: mocks.resolveAuthenticatedUserId,
  hasGroupWriteAccess: vi.fn(async () => true),
  canPostToGroup: vi.fn(async () => true),
  canModifyResource: mocks.canModifyResource,
  revalidateOwnerPaths: vi.fn(),
  createResourceWithLedger: vi.fn(),
}));
vi.mock("@/lib/federation/index", () => ({
  updateFacade: { execute: mocks.updateFacade, executeResourceAnchored: mocks.executeResourceAnchored },
  emitDomainEvent: mocks.emitDomainEvent,
  EVENT_TYPES: { RESOURCE_UPDATED: "resource.updated", RESOURCE_DELETED: "resource.deleted" },
}));
vi.mock("@/lib/federation/revocation-contract", () => ({
  buildRevocationPayload: vi.fn((p: unknown) => p),
}));
vi.mock("@/lib/federation/write-router", () => ({ routeWrite: mocks.routeWrite }));
vi.mock("@/lib/federation/resolution", () => ({ resolveHomeInstance: mocks.resolveHomeInstance }));
vi.mock("@/app/actions/resource-creation/types", () => ({ normalizeEventTickets: vi.fn(() => null) }));
vi.mock("@/app/actions/resource-creation/events", () => ({ syncEventTicketOfferings: vi.fn() }));
vi.mock("@/lib/google/calendar-sync", () => ({ syncResourceToGoogle: vi.fn() }));

import { updateResource, deleteResource } from "@/app/actions/resource-creation/lifecycle";

const STEWARD = "aa29fa2d-4c2a-4eaf-a069-b2203a2ce667";
const NATIVE_POST = "11111111-aaaa-4bbb-8ccc-000000000001";
const MIRROR_POST = "22222222-aaaa-4bbb-8ccc-000000000002";
const HOME_SIDE_ID = "33333333-aaaa-4bbb-8ccc-000000000003";

function resourceRow(overrides: Record<string, unknown>) {
  return {
    id: NATIVE_POST,
    ownerId: STEWARD,
    name: "post",
    description: null,
    metadata: { entityType: "post" },
    isPublic: true,
    visibility: "public",
    tags: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAuthenticatedUserId.mockResolvedValue(STEWARD);
  mocks.rateLimit.mockResolvedValue({ success: true });
  // Actions chain .catch onto the fire-and-forget federation emit.
  mocks.emitDomainEvent.mockResolvedValue(undefined);
  // Owner is sovereign-merged: their agent's home is NOT this instance.
  mocks.resolveHomeInstance.mockResolvedValue({ isLocal: false, nodeId: "remote-node" });
  mocks.updateFacade.mockResolvedValue({ success: true, data: undefined });
  // The anchored path runs the local executor's surrounding action logic; the
  // action only reads `.success` (and `.data` for delete), so a stub suffices.
  mocks.executeResourceAnchored.mockResolvedValue({
    success: true,
    data: { success: true, message: "ok" },
    executedOn: "local",
  });
  mocks.routeWrite.mockResolvedValue({ success: true, data: { success: true, message: "ok" } });
});

describe("group lifecycle write routing", () => {
  it("executes locally for a NATIVE row even when the owner is remote-homed", async () => {
    mocks.canModifyResource.mockResolvedValue({ allowed: true, resource: resourceRow({}) });

    const result = await updateResource({ resourceId: NATIVE_POST, name: "edited" });

    console.log("native update:", result, "| routeWrite:", mocks.routeWrite.mock.calls.length,
      "| owner-routed facade:", mocks.updateFacade.mock.calls.length,
      "| anchored:", mocks.executeResourceAnchored.mock.calls.length);
    expect(mocks.routeWrite).not.toHaveBeenCalled();
    // The owner-routing facade must never see a native row — it would resolve
    // the owner's home and forward (the second half of the defect).
    expect(mocks.updateFacade).not.toHaveBeenCalled();
    expect(mocks.executeResourceAnchored).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });



  it("deletes a NATIVE row locally even when the owner is remote-homed", async () => {
    mocks.canModifyResource.mockResolvedValue({ allowed: true, resource: resourceRow({}) });

    const result = await deleteResource(NATIVE_POST);

    console.log("native delete:", result, "| routeWrite:", mocks.routeWrite.mock.calls.length,
      "| owner-routed facade:", mocks.updateFacade.mock.calls.length,
      "| anchored:", mocks.executeResourceAnchored.mock.calls.length);
    expect(mocks.routeWrite).not.toHaveBeenCalled();
    expect(mocks.updateFacade).not.toHaveBeenCalled();
    expect(mocks.executeResourceAnchored).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it("forwards a MIRROR delete keyed on the home-side id", async () => {
    mocks.canModifyResource.mockResolvedValue({
      allowed: true,
      resource: resourceRow({ id: MIRROR_POST, metadata: { entityType: "post", externalEntityId: HOME_SIDE_ID } }),
    });

    const result = await deleteResource(MIRROR_POST);

    console.log("mirror delete:", result, "| routed payload:", mocks.routeWrite.mock.calls[0]?.[0]?.payload);
    expect(mocks.routeWrite).toHaveBeenCalledTimes(1);
    expect(mocks.routeWrite.mock.calls[0][0].payload.resourceId).toBe(HOME_SIDE_ID);
  });
});
