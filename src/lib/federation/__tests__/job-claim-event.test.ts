/**
 * Unit tests for the cross-instance `job.claimed` calendar event contract (A8).
 *
 * These lock the WIRE SHAPE that the person/global materializers consume: the
 * payload must be self-describing (claimant + job window + owning group + a
 * canonical job URL + origin provenance) so a home instance can render a
 * calendar item without fetching the job back from the origin. The instance
 * config is stubbed so the test is pure (no env dependence, no DB).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getInstanceConfig: vi.fn(),
}));

vi.mock("../instance-config", () => ({
  getInstanceConfig: mocks.getInstanceConfig,
}));

import {
  JOB_CLAIMED_EVENT_TYPE,
  buildJobClaimCalendarPayload,
  readStringMeta,
} from "../job-claim-event";

beforeEach(() => {
  mocks.getInstanceConfig.mockReset();
  mocks.getInstanceConfig.mockReturnValue({
    instanceId: "spirit-instance",
    baseUrl: "https://spirit.rivr.social/",
  });
});

describe("buildJobClaimCalendarPayload", () => {
  const input = {
    claimantId: "claimant-1",
    jobId: "job-1",
    jobName: "Trail cleanup",
    startDate: "2026-07-20T09:00:00.000Z",
    deadline: "2026-07-20T13:00:00.000Z",
    projectId: "project-1",
    groupId: "group-1",
    groupName: "Spirit of the Front Range",
    claimedAt: "2026-07-14T00:00:00.000Z",
  };

  it("carries every calendar-ready field with the fixed action discriminator", () => {
    const payload = buildJobClaimCalendarPayload(input);
    expect(payload).toMatchObject({
      action: "job_claimed",
      claimantId: "claimant-1",
      jobId: "job-1",
      jobName: "Trail cleanup",
      startDate: "2026-07-20T09:00:00.000Z",
      deadline: "2026-07-20T13:00:00.000Z",
      projectId: "project-1",
      groupId: "group-1",
      groupName: "Spirit of the Front Range",
      originInstanceId: "spirit-instance",
      claimedAt: "2026-07-14T00:00:00.000Z",
    });
  });

  it("builds a canonical job URL from the instance base, trimming trailing slashes", () => {
    const payload = buildJobClaimCalendarPayload(input);
    expect(payload.jobUrl).toBe("https://spirit.rivr.social/jobs/job-1");
  });

  it("preserves null work-window fields (a job with no dates)", () => {
    const payload = buildJobClaimCalendarPayload({
      ...input,
      startDate: null,
      deadline: null,
      projectId: null,
    });
    expect(payload.startDate).toBeNull();
    expect(payload.deadline).toBeNull();
    expect(payload.projectId).toBeNull();
  });

  it("exposes the dedicated event type constant", () => {
    expect(JOB_CLAIMED_EVENT_TYPE).toBe("job.claimed");
  });
});

describe("readStringMeta", () => {
  it("returns a trimmed string value", () => {
    expect(readStringMeta({ startDate: "  2026-07-20  " }, "startDate")).toBe("2026-07-20");
  });

  it("returns null for missing, empty, or non-string values", () => {
    expect(readStringMeta({}, "startDate")).toBeNull();
    expect(readStringMeta({ startDate: "   " }, "startDate")).toBeNull();
    expect(readStringMeta({ startDate: 42 }, "startDate")).toBeNull();
    expect(readStringMeta(null, "startDate")).toBeNull();
    expect(readStringMeta(undefined, "startDate")).toBeNull();
  });
});
