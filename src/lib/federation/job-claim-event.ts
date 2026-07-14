/**
 * @fileoverview Cross-instance "job claimed" calendar event contract (A8).
 *
 * When a worker claims a job on THIS sovereign group (e.g. a Spirit member, or
 * a federated remote-viewer whose HOME instance is person/global), their claimed
 * job should appear on their HOME profile calendar — even though the job
 * resource itself lives here and never federates to the claimant's home.
 *
 * The group is the EMIT side of that contract: on a real (non-pending) claim we
 * emit a self-describing `job.claimed` domain event whose payload carries
 * everything a home instance needs to materialize a calendar item WITHOUT
 * fetching the job back from us — the claimant, the job's name + work window
 * (startDate → deadline), the owning group, and a canonical link to the job on
 * this instance.
 *
 * The MATERIALIZE side lives in the person + global apps (their federation
 * projection consumer): on receiving `job.claimed` for a locally-homed
 * `claimantId`, upsert a lightweight "claimed job" calendar projection that the
 * profile calendar reads (idempotent on `{claimantId, jobId}`; removed/expired
 * when the claim is released). Keep {@link JobClaimCalendarPayload} in lockstep
 * across repos — it IS the wire contract.
 */

import { getInstanceConfig } from "./instance-config";

/**
 * Dedicated event type for a cross-instance job claim. Intentionally distinct
 * from the generic `resource.updated` signal so a home consumer can key on it
 * deterministically instead of trying (and failing) to upsert a job resource it
 * has never seen. Peers that don't yet handle it ignore it safely.
 */
export const JOB_CLAIMED_EVENT_TYPE = "job.claimed" as const;

/**
 * Wire payload for {@link JOB_CLAIMED_EVENT_TYPE}. Self-describing so the home
 * instance can render a calendar item with no round-trip back to the origin.
 */
export interface JobClaimCalendarPayload {
  /** Marks the semantic action for consumers that branch on `payload.action`. */
  action: "job_claimed";
  /** The claimant agent id — the home instance keys materialization on this. */
  claimantId: string;
  /** The claimed job's resource id (on the origin instance). */
  jobId: string;
  /** Human-readable job name for the calendar entry title. */
  jobName: string;
  /** ISO work-window start, when the job carries one (else null). */
  startDate: string | null;
  /** ISO work-window end / deadline, when the job carries one (else null). */
  deadline: string | null;
  /** Parent project id, when the job belongs to one (else null). */
  projectId: string | null;
  /** Owning group agent id. */
  groupId: string;
  /** Owning group display name (so the home entry is self-labeled). */
  groupName: string;
  /** Canonical URL to the job on the origin instance. */
  jobUrl: string;
  /** Origin instance id (the emitter), for provenance + dedup. */
  originInstanceId: string;
  /** ISO timestamp of the claim. */
  claimedAt: string;
}

/** Inputs the caller resolves from the job resource + claim context. */
export interface BuildJobClaimCalendarPayloadInput {
  claimantId: string;
  jobId: string;
  jobName: string;
  startDate: string | null;
  deadline: string | null;
  projectId: string | null;
  groupId: string;
  groupName: string;
  /** Claim timestamp; caller supplies so it matches the ledger row. */
  claimedAt: string;
}

/**
 * Builds the self-describing {@link JobClaimCalendarPayload} for a job claim,
 * stamping the origin instance id + a canonical job URL from the instance
 * config. Pure aside from reading the (process-wide) instance config.
 */
export function buildJobClaimCalendarPayload(
  input: BuildJobClaimCalendarPayloadInput,
): JobClaimCalendarPayload {
  const config = getInstanceConfig();
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  return {
    action: "job_claimed",
    claimantId: input.claimantId,
    jobId: input.jobId,
    jobName: input.jobName,
    startDate: input.startDate,
    deadline: input.deadline,
    projectId: input.projectId,
    groupId: input.groupId,
    groupName: input.groupName,
    jobUrl: `${baseUrl}/jobs/${input.jobId}`,
    originInstanceId: config.instanceId,
    claimedAt: input.claimedAt,
  };
}

/** Reads a string metadata value, returning null for missing/non-string. */
export function readStringMeta(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
