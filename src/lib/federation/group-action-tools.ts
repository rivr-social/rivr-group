/**
 * Group action tools — the single source of truth for the "do things in the
 * group" capabilities exposed to BOTH the MCP surface (an external agent
 * authenticated to act as the group) AND the group's admin assistant chat.
 *
 * Each tool is a thin wrapper over an existing `resource-creation` /
 * `interactions` server action. Those actions resolve the acting principal via
 * `resolveAuthenticatedUserId()` / `getCurrentUserId()`, which read the MCP
 * execution context first (so under an MCP token the actor is the group agent)
 * and fall back to the NextAuth session (so from the assistant chat the actor
 * is the admin user). Either way we pass `groupId`/`ownerId` = the group so the
 * created resource is owned by and homes on the group.
 *
 * Admin-gated actions (projects, task approval, contribution credit) pass
 * because the group admin-gate (`hasGroupManageAccess`) honors the delegating
 * controller of an MCP session — see `resource-creation/helpers.ts`.
 *
 * Adapters turn this one list into the two surface-specific shapes:
 *   - {@link toMcpToolDefinitions} → MCP `McpToolDefinition[]`
 *   - {@link buildGroupActionToolset} → assistant `{ tools, executeTool }`
 */

import type { NativeChatToolSpec } from "@/lib/ai/native-chat";
import {
  createProjectResource,
  createEventResource,
  createOfferingResource,
  createDocumentResourceAction,
  createGroupResource,
  updateGroupResource,
  deleteGroupResource,
  updateResource,
  deleteResource,
} from "@/app/actions/resource-creation";
import { dollarsToCents } from "@/app/actions/resource-creation/types";
import { updateTaskStatus, claimTasksAction } from "@/app/actions/interactions/tasks";
import {
  claimJobAction,
  recordJobContributionAction,
} from "@/app/actions/interactions/project-team";
import { addJobToProjectAction, addTaskToJobAction } from "@/app/actions/job-management";
import { inviteGroupMemberAction } from "@/app/actions/group-members";
import { markJobDoneAction } from "@/app/actions/job-completion";
import { completeProjectAction, ensureSubgroupTreasuriesAction } from "@/app/actions/project-completion";
import { backfillConnectAccountsAction } from "@/app/actions/wallet/connect-backfill";
import {
  getCryptoTreasuryOverviewAction,
  createBudgetProposalsAction,
  createTransferProposalAction,
} from "@/app/actions/wallet/crypto-treasury";
import { getResourcesByOwnerAndType, getResourcesByOwnerSubtreeAndType, getTaskCountsByJob } from "@/lib/queries/resources";

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = str(args[key]);
  if (!value) throw new Error(`"${key}" is required.`);
  return value;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Coerce a DOLLAR-denominated tool argument to the integer CENTS the resource
 * actions persist. Returns `undefined` when the caller omitted the field so the
 * action leaves the price unset rather than writing a `0` price.
 */
function dollarArgToCents(value: unknown): number | undefined {
  const dollars = num(value);
  return dollars === undefined ? undefined : dollarsToCents(dollars);
}

function strArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
    : [];
}

/**
 * Coerce an optional ISO date/datetime arg, validating it parses. Returns
 * `undefined` when the key is absent/blank (so the field is left unchanged on
 * update) and throws a precise error when a non-empty value is not a valid date.
 */
function optionalIsoDate(args: Record<string, unknown>, key: string): string | undefined {
  const value = str(args[key]);
  if (value === undefined) return undefined;
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`"${key}" must be a valid ISO date string (e.g. "2026-08-15" or "2026-08-15T18:00:00Z").`);
  }
  return value;
}

/**
 * Coerce an optional `{ start, end }` timeframe arg into a normalized object of
 * validated ISO strings (null when a bound is omitted). Returns `undefined` when
 * no timeframe object is supplied. Throws when either bound is a non-empty
 * non-date value.
 */
function readTimeframe(args: Record<string, unknown>): { start: string | null; end: string | null } | undefined {
  const raw = args.timeframe;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const start = str(obj.start);
  const end = str(obj.end);
  if (start !== undefined && !Number.isFinite(Date.parse(start))) {
    throw new Error(`"timeframe.start" must be a valid ISO date string.`);
  }
  if (end !== undefined && !Number.isFinite(Date.parse(end))) {
    throw new Error(`"timeframe.end" must be a valid ISO date string.`);
  }
  return { start: start ?? null, end: end ?? null };
}

// ---------------------------------------------------------------------------
// Project/job listing (read model)
// ---------------------------------------------------------------------------

/** A minimal resource row shape the listing builder needs (id/name/metadata). */
export interface ListableResource {
  id: string;
  name: string;
  metadata: Record<string, unknown> | null;
}

/** A job nested under its project in the listing read model. */
export interface ProjectListingJob {
  id: string;
  name: string;
  startDate: string | null;
  deadline: string | null;
  date: string | null;
  assignees: string[];
  maxAssignees: number | null;
  /** Number of child tasks on this job — lets a caller skip already-populated jobs. */
  taskCount: number;
  /** Pay model + amounts, so a caller can see which jobs still need a cost. */
  payKind: "fixed" | "hourly" | "volunteer" | null;
  payAmountCents: number | null;
  hourlyRateCents: number | null;
}

/** A project with its date range and nested jobs in the listing read model. */
export interface ProjectListingProject {
  id: string;
  name: string;
  status: string | null;
  timeframe: { start: string | null; end: string | null };
  jobs: ProjectListingJob[];
}

function metadataOf(resource: ListableResource): Record<string, unknown> {
  return (resource.metadata ?? {}) as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Nest jobs under their parent projects by `metadata.projectId` (the canonical
 * link the create flow writes on each job). Surfaces each project's status +
 * `metadata.timeframe {start,end}` and, per job, its scheduling metadata
 * (startDate/deadline/date), assignees, and slot cap — exactly the fields an org
 * agent needs to audit and repair project/job dates. Jobs with no `projectId`
 * link are omitted (they belong to no project).
 */
export function buildProjectListing(
  projects: ListableResource[],
  jobs: ListableResource[],
  taskCountByJob: Map<string, number> = new Map(),
): ProjectListingProject[] {
  const jobsByProject = new Map<string, ProjectListingJob[]>();
  for (const job of jobs) {
    const meta = metadataOf(job);
    const projectId = readString(meta.projectId);
    if (!projectId) continue;
    const payKind =
      meta.payKind === "fixed" || meta.payKind === "hourly" || meta.payKind === "volunteer"
        ? meta.payKind
        : null;
    const entry: ProjectListingJob = {
      id: job.id,
      name: job.name,
      startDate: readString(meta.startDate),
      deadline: readString(meta.deadline),
      date: readString(meta.date),
      assignees: strArray(meta.assignees),
      maxAssignees: readNumber(meta.maxAssignees),
      taskCount: taskCountByJob.get(job.id) ?? 0,
      payKind,
      payAmountCents: payKind === "fixed" ? readNumber(meta.payAmountCents) : null,
      hourlyRateCents: payKind === "hourly" ? readNumber(meta.hourlyRateCents) : null,
    };
    const bucket = jobsByProject.get(projectId);
    if (bucket) bucket.push(entry);
    else jobsByProject.set(projectId, [entry]);
  }

  return projects.map((project) => {
    const meta = metadataOf(project);
    const timeframe =
      meta.timeframe && typeof meta.timeframe === "object" && !Array.isArray(meta.timeframe)
        ? (meta.timeframe as Record<string, unknown>)
        : {};
    return {
      id: project.id,
      name: project.name,
      status: readString(meta.status),
      timeframe: {
        start: readString(timeframe.start),
        end: readString(timeframe.end),
      },
      jobs: jobsByProject.get(project.id) ?? [],
    };
  });
}

/** A group-owned event in the listing read model. */
export interface EventListingEvent {
  id: string;
  name: string;
  date: string | null;
  startDate: string | null;
  time: string | null;
  location: string | null;
  status: string | null;
}

/**
 * Project the scheduling-relevant fields of each group-owned event resource —
 * the mirror of {@link buildProjectListing} for events. The rendered date is
 * composed downstream from `metadata.date` + `metadata.time` (falling back to
 * `metadata.startDate` for explicit-ISO records), so all three are surfaced so
 * an org agent can audit and repair when an event happens.
 */
export function buildEventListing(events: ListableResource[]): EventListingEvent[] {
  return events.map((event) => {
    const meta = metadataOf(event);
    return {
      id: event.id,
      name: event.name,
      date: readString(meta.date),
      startDate: readString(meta.startDate),
      time: readString(meta.time),
      location: readString(meta.location),
      status: readString(meta.status),
    };
  });
}

/**
 * Normalize the optional per-job scheduling fields (startDate/deadline/date) an
 * org agent may pass when creating jobs nested under a project, validating each
 * as an ISO date string exactly like the {@link optionalIsoDate} update tools do
 * (throwing on a non-empty non-date). Non-date job fields (title, description,
 * category, skills, tasks, …) pass through untouched. Returns `undefined` when
 * no jobs array is supplied so the create action leaves jobs unset.
 */
function normalizeJobCreationDates(rawJobs: unknown): unknown[] | undefined {
  if (!Array.isArray(rawJobs)) return undefined;
  return rawJobs.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const job = raw as Record<string, unknown>;
    const normalized: Record<string, unknown> = { ...job };
    const startDate = optionalIsoDate(job, "startDate");
    if (startDate !== undefined) normalized.startDate = startDate;
    const deadline = optionalIsoDate(job, "deadline");
    if (deadline !== undefined) normalized.deadline = deadline;
    const date = optionalIsoDate(job, "date");
    if (date !== undefined) normalized.date = date;
    return normalized;
  });
}

/** How many group-owned jobs to scan when nesting under projects. */
const PROJECT_LISTING_JOB_SCAN_CAP = 500;

/**
 * The group a create should be owned by: an explicit `groupId` arg (a subgroup /
 * "circle" the actor administers) when given, otherwise the surface's default
 * group (the primary group for MCP, the chat's group for the assistant). The
 * underlying server action enforces write access to whichever group is chosen.
 */
function pickGroup(args: Record<string, unknown>, ctx: { groupId: string }): string {
  return str(args.groupId) ?? ctx.groupId;
}

/** Reusable schema fragment: optionally target a subgroup/circle. */
const GROUP_ID_PROP = {
  groupId: {
    type: "string",
    description:
      "Optional: own this by a specific subgroup/circle the actor administers. Defaults to the primary group.",
  },
} as const;

const TASK_STATUSES = [
  "not_started",
  "in_progress",
  "awaiting_approval",
  "completed",
  "rejected",
] as const;
type TaskStatusValue = (typeof TASK_STATUSES)[number];

// ---------------------------------------------------------------------------
// Tool contract
// ---------------------------------------------------------------------------

export interface GroupActionTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Execute against the group identified by `ctx.groupId`. */
  run: (args: Record<string, unknown>, ctx: { groupId: string }) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export const GROUP_ACTION_TOOLS: GroupActionTool[] = [
  {
    name: "rivr.projects.create",
    description:
      "Create a project owned by this group, optionally with nested jobs and tasks created atomically. " +
      "Use this for projects, work items (jobs), and their tasks. Requires group-admin authority.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "description", "category"],
      properties: {
        ...GROUP_ID_PROP,
        title: { type: "string" },
        description: { type: "string" },
        category: { type: "string", description: "Project category, e.g. 'events', 'operations'." },
        deadline: { type: "string", description: "ISO date/time the project is due, e.g. '2026-08-31'." },
        timeframe: {
          type: "object",
          additionalProperties: false,
          description: "Project date range (ISO date strings). Persisted at creation — no follow-up update needed.",
          properties: {
            start: { type: "string", description: "ISO start date, e.g. '2026-08-01'." },
            end: { type: "string", description: "ISO end date, e.g. '2026-08-31'." },
          },
        },
        budget: { type: "number", description: "Optional budget amount." },
        jobs: {
          type: "array",
          description:
            "Optional jobs to create under the project. Each job may carry its own schedule (startDate/deadline/date) and tasks.",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["title", "description"],
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              category: { type: "string" },
              maxAssignees: { type: "number" },
              startDate: { type: "string", description: "ISO start date for the job." },
              deadline: { type: "string", description: "ISO deadline date for the job." },
              date: { type: "string", description: "ISO scheduled date for the job." },
              skills: { type: "array", items: { type: "string" } },
              tasks: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: true,
                  required: ["name"],
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    estimatedTime: { type: "number" },
                    points: { type: "number" },
                    required: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
    run: (args, ctx) =>
      createProjectResource({
        title: requireStr(args, "title"),
        description: requireStr(args, "description"),
        category: requireStr(args, "category"),
        groupId: pickGroup(args, ctx),
        deadline: optionalIsoDate(args, "deadline"),
        timeframe: readTimeframe(args),
        budget: num(args.budget) ?? null,
        jobs: normalizeJobCreationDates(args.jobs),
      }),
  },
  {
    name: "rivr.projects.list",
    description:
      "List the group's projects (INCLUDING those owned by its nested subgroups/circles by default), each with its jobs " +
      "nested underneath (jobs are matched to a project by their metadata.projectId). For every project it returns id, name, " +
      "status, and metadata.timeframe {start,end}; for every job it returns id, name, startDate/deadline/date, assignees, " +
      "maxAssignees, taskCount (skip jobs that already have tasks), and payKind/payAmountCents/hourlyRateCents (see which " +
      "jobs still need a cost). Use this to audit and repair project/job schedules, tasks, and costs across the whole org. " +
      "Defaults to the primary group " +
      "and its subtree; pass groupId to target a specific subgroup/circle, or scope:'group' to list only the target's own " +
      "projects (exclude subgroups).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...GROUP_ID_PROP,
        scope: {
          type: "string",
          enum: ["subtree", "group"],
          description: "'subtree' (default) includes nested subgroups' projects; 'group' lists only the target group's own.",
        },
        limit: { type: "number", description: "Max projects to return. Defaults to 200." },
      },
    },
    run: async (args, ctx) => {
      const groupId = pickGroup(args, ctx);
      const includeSubtree = args.scope !== "group";
      const limit = num(args.limit) ?? 200;
      const [projects, jobs] = includeSubtree
        ? await Promise.all([
            getResourcesByOwnerSubtreeAndType(groupId, "project", limit),
            getResourcesByOwnerSubtreeAndType(groupId, "job", PROJECT_LISTING_JOB_SCAN_CAP),
          ])
        : await Promise.all([
            getResourcesByOwnerAndType(groupId, "project", limit),
            getResourcesByOwnerAndType(groupId, "job", PROJECT_LISTING_JOB_SCAN_CAP),
          ]);
      // Per-job task counts so callers can skip already-populated jobs.
      const taskCounts = await getTaskCountsByJob(jobs.map((job) => job.id));
      const listing = buildProjectListing(projects, jobs, taskCounts);
      return { groupId, scope: includeSubtree ? "subtree" : "group", count: listing.length, projects: listing };
    },
  },
  {
    name: "rivr.projects.update",
    description:
      "Update a project the actor may manage (owner or group write/admin authority). " +
      "Set the schedule via timeframe {start,end} (ISO date strings), and/or change name, description, or status. " +
      "Only the fields you pass are changed; timeframe/status merge into the project metadata. Requires write authority on the project's group.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectId"],
      properties: {
        projectId: { type: "string", description: "The project resource id to update." },
        timeframe: {
          type: "object",
          additionalProperties: false,
          description: "Project date range. Provide ISO date strings.",
          properties: {
            start: { type: "string", description: "ISO start date, e.g. '2026-08-01'." },
            end: { type: "string", description: "ISO end date, e.g. '2026-08-31'." },
          },
        },
        name: { type: "string" },
        description: { type: "string" },
        status: { type: "string", description: "Project status, e.g. 'planning', 'in_progress', 'completed'." },
      },
    },
    run: (args) => {
      const resourceId = requireStr(args, "projectId");
      const metadataPatch: Record<string, unknown> = {};
      const timeframe = readTimeframe(args);
      if (timeframe) metadataPatch.timeframe = timeframe;
      const status = str(args.status);
      if (status) metadataPatch.status = status;
      const name = str(args.name);
      const description = str(args.description);
      if (
        Object.keys(metadataPatch).length === 0 &&
        name === undefined &&
        description === undefined
      ) {
        throw new Error("Provide at least one field to update (timeframe, name, description, or status).");
      }
      return updateResource({
        resourceId,
        name,
        description,
        metadataPatch: Object.keys(metadataPatch).length > 0 ? metadataPatch : undefined,
      });
    },
  },
  {
    name: "rivr.jobs.update",
    description:
      "Update a job (a work item under a project) the actor may manage (owner or group write/admin authority). " +
      "Repair its schedule with startDate, deadline, and/or date (ISO date strings), and/or set status or maxAssignees. " +
      "Only the fields you pass are changed; they merge into the job metadata. Requires write authority on the job's group.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: {
        jobId: { type: "string", description: "The job resource id to update." },
        name: { type: "string", description: "New job title." },
        description: { type: "string", description: "New job description (e.g. append a cost-estimate note here)." },
        startDate: { type: "string", description: "ISO start date." },
        deadline: { type: "string", description: "ISO deadline date." },
        date: { type: "string", description: "ISO scheduled date." },
        status: { type: "string", description: "Job status, e.g. 'open', 'in_progress', 'completed'." },
        maxAssignees: { type: "number", description: "Maximum number of assignees (claim slots)." },
        payKind: {
          type: "string",
          enum: ["fixed", "hourly", "volunteer", "none"],
          description:
            "Pay model: 'fixed' (payAmountCents), 'hourly' (hourlyRateCents), 'volunteer' (no cash — mints a Thanks voucher the group claims per volunteer at completion), or 'none' to clear.",
        },
        payAmountCents: { type: "number", description: "Fixed cash value in cents (payKind 'fixed')." },
        hourlyRateCents: { type: "number", description: "Hourly rate in cents (payKind 'hourly')." },
        maxHours: {
          type: "number",
          description: "Hour budget: hourly payout is clamped to this many hours. Pass 0 to clear.",
        },
        points: {
          type: "number",
          description: "Job-level points for task-less jobs (split across assignees at completion). Pass 0 to clear.",
        },
      },
    },
    run: (args) => {
      const resourceId = requireStr(args, "jobId");
      const name = str(args.name);
      const description = str(args.description);
      const metadataPatch: Record<string, unknown> = {};
      const startDate = optionalIsoDate(args, "startDate");
      if (startDate !== undefined) metadataPatch.startDate = startDate;
      const deadline = optionalIsoDate(args, "deadline");
      if (deadline !== undefined) metadataPatch.deadline = deadline;
      const date = optionalIsoDate(args, "date");
      if (date !== undefined) metadataPatch.date = date;
      const status = str(args.status);
      if (status) metadataPatch.status = status;
      const maxAssignees = num(args.maxAssignees);
      if (maxAssignees !== undefined) metadataPatch.maxAssignees = maxAssignees;
      const maxHours = num(args.maxHours);
      if (maxHours !== undefined) metadataPatch.maxHours = maxHours > 0 ? maxHours : null;
      const jobPoints = num(args.points);
      if (jobPoints !== undefined) metadataPatch.points = jobPoints > 0 ? jobPoints : null;
      if (args.payKind === "none") {
        metadataPatch.payKind = null;
        metadataPatch.payAmountCents = null;
        metadataPatch.hourlyRateCents = null;
      } else if (args.payKind === "volunteer") {
        // Volunteer pay carries no cash fields; clear any prior amounts.
        metadataPatch.payKind = "volunteer";
        metadataPatch.payAmountCents = null;
        metadataPatch.hourlyRateCents = null;
      } else if (args.payKind === "fixed" || args.payKind === "hourly") {
        metadataPatch.payKind = args.payKind;
        const payAmountCents = num(args.payAmountCents);
        const hourlyRateCents = num(args.hourlyRateCents);
        metadataPatch.payAmountCents =
          args.payKind === "fixed" && payAmountCents !== undefined && payAmountCents > 0
            ? Math.round(payAmountCents)
            : null;
        metadataPatch.hourlyRateCents =
          args.payKind === "hourly" && hourlyRateCents !== undefined && hourlyRateCents > 0
            ? Math.round(hourlyRateCents)
            : null;
      }
      if (
        Object.keys(metadataPatch).length === 0 &&
        name === undefined &&
        description === undefined
      ) {
        throw new Error(
          "Provide at least one field to update (name, description, startDate, deadline, date, status, maxAssignees, maxHours, points, or payKind/payAmountCents/hourlyRateCents).",
        );
      }
      return updateResource({
        resourceId,
        name,
        description,
        metadataPatch: Object.keys(metadataPatch).length > 0 ? metadataPatch : undefined,
      });
    },
  },
  {
    name: "rivr.events.update",
    description:
      "Update an event the actor may manage (owner or group write/admin authority). " +
      "Repair when it happens with date (ISO date, e.g. '2026-08-15') and startTime/endTime (e.g. '18:00'), " +
      "or startDate for explicit-ISO records. Only the fields you pass are changed; they merge into the event metadata. " +
      "Requires write authority on the event's group.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["eventId"],
      properties: {
        eventId: { type: "string", description: "The event resource id to update." },
        date: { type: "string", description: "Event date, e.g. '2026-08-15'. This is the primary rendered date." },
        startDate: { type: "string", description: "Explicit ISO start datetime (alternate to date, used when date is unset)." },
        startTime: { type: "string", description: "Start time of day, e.g. '18:00'." },
        endTime: { type: "string", description: "End time of day, e.g. '21:00'." },
      },
    },
    run: (args) => {
      const resourceId = requireStr(args, "eventId");
      const metadataPatch: Record<string, unknown> = {};
      // Event render (graph-adapters agentToEvent/resourceToEventAgent) composes
      // the displayed date from metadata.date + metadata.time, falling back to
      // metadata.startDate. Map startTime -> metadata.time so a time repair
      // actually moves the rendered time.
      const date = optionalIsoDate(args, "date");
      if (date !== undefined) metadataPatch.date = date;
      const startDate = optionalIsoDate(args, "startDate");
      if (startDate !== undefined) metadataPatch.startDate = startDate;
      const startTime = str(args.startTime);
      if (startTime) metadataPatch.time = startTime;
      const endTime = str(args.endTime);
      if (endTime) metadataPatch.endTime = endTime;
      if (Object.keys(metadataPatch).length === 0) {
        throw new Error("Provide at least one field to update (date, startDate, startTime, or endTime).");
      }
      return updateResource({ resourceId, metadataPatch });
    },
  },
  {
    name: "rivr.events.create",
    description:
      "Create an event owned by this group. Scheduled with a date + time + location. " +
      "Set eventType to 'in-person' or 'online'. Paid ticketing requires the group to have a host entitlement.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "description", "date", "time", "location", "eventType"],
      properties: {
        ...GROUP_ID_PROP,
        title: { type: "string" },
        description: { type: "string" },
        date: { type: "string", description: "Event date, e.g. '2026-08-15'." },
        time: { type: "string", description: "Event time, e.g. '18:00'." },
        location: { type: "string" },
        eventType: { type: "string", enum: ["in-person", "online"] },
        price: { type: "number", description: "Optional ticket price in dollars." },
        imageUrl: { type: "string" },
      },
    },
    run: (args, ctx) =>
      createEventResource({
        title: requireStr(args, "title"),
        description: requireStr(args, "description"),
        date: requireStr(args, "date"),
        time: requireStr(args, "time"),
        location: requireStr(args, "location"),
        eventType: (str(args.eventType) === "online" ? "online" : "in-person") as
          | "in-person"
          | "online",
        price: num(args.price) ?? null,
        imageUrl: str(args.imageUrl),
        ownerId: pickGroup(args, ctx),
      }),
  },
  {
    name: "rivr.events.list",
    description:
      "List the group's events, each with its scheduling metadata: id, name, date, startDate, time, " +
      "location, and status. Use this to audit and repair event schedules (pair with rivr.events.update). " +
      "Defaults to the primary group; pass groupId to target a subgroup/circle the actor administers.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...GROUP_ID_PROP,
        limit: { type: "number", description: "Max events to return. Defaults to 50." },
      },
    },
    run: async (args, ctx) => {
      const groupId = pickGroup(args, ctx);
      const limit = num(args.limit) ?? 50;
      const events = await getResourcesByOwnerAndType(groupId, "event", limit);
      const listing = buildEventListing(events);
      return { groupId, count: listing.length, events: listing };
    },
  },
  {
    name: "rivr.events.delete",
    description:
      "Delete (soft-delete) an event the actor may manage (owner or group write/admin authority). " +
      "The event is marked deleted (recoverable) rather than hard-removed. " +
      "Requires write authority on the event's group — the same gate as rivr.events.update.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["eventId"],
      properties: {
        eventId: { type: "string", description: "The event resource id to delete." },
      },
    },
    run: (args) => deleteResource(requireStr(args, "eventId")),
  },
  {
    name: "rivr.offerings.create",
    description:
      "Create a marketplace offering (product, service, etc.) sold AS this group. " +
      "Provide an offeringType and, for paid offerings, a basePrice in dollars. " +
      "Paid offerings require the group's seller entitlement + payments setup.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "description", "offeringType"],
      properties: {
        ...GROUP_ID_PROP,
        title: { type: "string" },
        description: { type: "string" },
        offeringType: {
          type: "string",
          description: "e.g. 'product', 'service', 'ticket', 'skill', 'bounty'.",
        },
        basePrice: { type: "number", description: "Price in dollars. Omit for a free offering." },
        currency: { type: "string", description: "Currency code, default USD." },
        quantityAvailable: { type: "number" },
        category: { type: "string" },
        imageUrl: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
    run: (args, ctx) =>
      createOfferingResource({
        title: requireStr(args, "title"),
        description: requireStr(args, "description"),
        offeringType: requireStr(args, "offeringType"),
        // This tool's schema is denominated in DOLLARS; the action takes CENTS.
        basePrice: dollarArgToCents(args.basePrice),
        currency: str(args.currency),
        quantityAvailable: num(args.quantityAvailable),
        category: str(args.category),
        imageUrl: str(args.imageUrl),
        tags: strArray(args.tags),
        targetAgentTypes: ["person"],
        ownerId: pickGroup(args, ctx),
      }),
  },
  {
    name: "rivr.documents.create",
    description:
      "Create a document resource owned by this group (e.g. notes, guides, meeting minutes). " +
      "Optionally show it on the group's About page.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: {
        ...GROUP_ID_PROP,
        title: { type: "string" },
        content: { type: "string", description: "Markdown body of the document." },
        description: { type: "string" },
        category: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        showOnAbout: { type: "boolean" },
      },
    },
    run: (args, ctx) =>
      createDocumentResourceAction({
        groupId: pickGroup(args, ctx),
        title: requireStr(args, "title"),
        content: str(args.content),
        description: str(args.description),
        category: str(args.category),
        tags: strArray(args.tags),
        showOnAbout: args.showOnAbout === true,
      }),
  },
  {
    name: "rivr.groups.create",
    description:
      "Create a group, or a nested subgroup (a 'circle') under a parent group. " +
      "By default the new group is nested under the acting group (so you can build circles under it); " +
      "pass parentGroupId to nest elsewhere, or set standalone=true for a top-level group. " +
      "If the parent group is an organization, the new subgroup inherits organization-grade capabilities. " +
      "Creating a subgroup requires admin authority on the parent. The new group is owned/administered by the acting agent, " +
      "so you can then create projects, events, and offerings owned by it (pass its id as groupId on those tools).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "description"],
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        groupType: {
          type: "string",
          description: "Group type, e.g. 'basic' (default) or 'organization'. Organization parents keep subgroups org-grade.",
        },
        parentGroupId: {
          type: "string",
          description:
            "Parent group to nest under. Defaults to the acting group. Ignored when standalone=true.",
        },
        standalone: {
          type: "boolean",
          description: "Create a top-level group with no parent instead of nesting. Default false.",
        },
        chapter: {
          type: "string",
          description: "Locale/chapter scope tag, or 'all' (default) for unscoped.",
        },
      },
    },
    run: (args, ctx) => {
      const standalone = args.standalone === true;
      const parentGroupId = standalone ? null : (str(args.parentGroupId) ?? ctx.groupId);
      return createGroupResource({
        name: requireStr(args, "name"),
        description: requireStr(args, "description"),
        groupType: str(args.groupType) ?? "basic",
        chapter: str(args.chapter) ?? "all",
        parentGroupId,
      });
    },
  },
  {
    name: "rivr.groups.update",
    description:
      "Update a group or subgroup's name and/or description. Defaults to the acting group; " +
      "pass groupId to target a subgroup you administer. Requires admin authority.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        groupId: {
          type: "string",
          description: "Group/subgroup to update. Defaults to the primary/acting group.",
        },
        name: { type: "string" },
        description: { type: "string" },
      },
    },
    run: (args, ctx) =>
      updateGroupResource({
        groupId: str(args.groupId) ?? ctx.groupId,
        name: str(args.name),
        description: str(args.description),
      }),
  },
  {
    name: "rivr.groups.delete",
    description:
      "Delete (soft-delete) a group or subgroup. groupId is REQUIRED — there is no default, " +
      "to avoid accidentally deleting the primary group. Requires admin authority.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["groupId"],
      properties: {
        groupId: { type: "string", description: "The group/subgroup id to delete." },
      },
    },
    run: (args) => deleteGroupResource(requireStr(args, "groupId")),
  },
  {
    name: "rivr.groups.invite_member",
    description:
      "INVITE a person to a group as member or admin (admin authority required). Consent model: " +
      "membership starts only when the person ACCEPTS — groups can never add someone directly. " +
      "Idempotent: an existing pending invitation is refreshed, current members are rejected. " +
      "Works for remote-homed people via their projected local agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["agentId"],
      properties: {
        groupId: {
          type: "string",
          description: "Group/subgroup to invite into. Defaults to the primary/acting group.",
        },
        agentId: { type: "string", description: "The person agent id to invite." },
        role: { type: "string", enum: ["member", "admin"], description: "Role offered (default member)." },
      },
    },
    run: (args, ctx) =>
      inviteGroupMemberAction(
        str(args.groupId) ?? ctx.groupId,
        requireStr(args, "agentId"),
        args.role === "admin" ? "admin" : "member",
      ),
  },
  {
    name: "rivr.tasks.update_status",
    description:
      "Update the status of an existing task. Valid statuses: not_started, in_progress, " +
      "awaiting_approval, completed, rejected. Marking a task completed/rejected requires admin authority.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["taskId", "status"],
      properties: {
        taskId: { type: "string" },
        status: { type: "string", enum: [...TASK_STATUSES] },
      },
    },
    run: (args) => {
      const status = str(args.status);
      if (!status || !TASK_STATUSES.includes(status as TaskStatusValue)) {
        throw new Error(`"status" must be one of: ${TASK_STATUSES.join(", ")}.`);
      }
      return updateTaskStatus(requireStr(args, "taskId"), status as TaskStatusValue);
    },
  },
  {
    name: "rivr.tasks.claim",
    description: "Claim one or more tasks (assign them to the acting agent).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["taskIds"],
      properties: {
        taskIds: { type: "array", items: { type: "string" } },
      },
    },
    run: (args) => {
      const taskIds = strArray(args.taskIds);
      if (taskIds.length === 0) throw new Error(`"taskIds" must be a non-empty array.`);
      return claimTasksAction(taskIds);
    },
  },
  {
    name: "rivr.jobs.claim",
    description:
      "Claim a job (a work item under a project). Enforces the job's badge/slot/status eligibility rules.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: { jobId: { type: "string" } },
    },
    run: (args) => claimJobAction(requireStr(args, "jobId")),
  },
  {
    name: "rivr.payments.backfill_connect_accounts",
    description:
      "Ensure every SUBSCRIBING member has a Stripe Connect payment account: local agents holding an active/trialing " +
      "membership subscription, plus the group agent itself (the sovereign group is an Organization-grade subscriber). " +
      "New activations are provisioned automatically by the Stripe webhook — this backfills members who subscribed before " +
      "that wiring, and retries activation-time failures. Idempotent and re-run safe — agents that already have an account " +
      "are counted as existing, and one agent failing does not abort the batch (per-agent failures are returned). " +
      "Requires admin authority.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        groupId: {
          type: "string",
          description:
            "Optional: include this group agent in the batch instead of the primary group. Subscribing members are always included.",
        },
      },
    },
    run: (args, ctx) => backfillConnectAccountsAction(str(args.groupId) ?? ctx.groupId),
  },
  {
    name: "rivr.jobs.record_contribution",
    description:
      "Credit a contributor with completing a job (records a completion contribution). Requires admin authority.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId", "contributorId"],
      properties: {
        jobId: { type: "string" },
        contributorId: { type: "string", description: "Agent id of the contributor to credit." },
      },
    },
    run: (args) =>
      recordJobContributionAction({
        jobId: requireStr(args, "jobId"),
        contributorId: requireStr(args, "contributorId"),
      }),
  },
  {
    name: "rivr.jobs.create",
    description:
      "Add a job to an EXISTING project (owner or group write/admin authority). The job inherits the project's " +
      "visibility and scope. Optionally set a pay model: payKind 'fixed' with payAmountCents, 'hourly' with " +
      "hourlyRateCents, or 'volunteer' (no cash — mints a Thanks voucher the group claims per volunteer at " +
      "completion; all alongside task points, which live on tasks).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectId", "title"],
      properties: {
        projectId: { type: "string", description: "The project resource id to add the job under." },
        title: { type: "string" },
        description: { type: "string" },
        category: { type: "string" },
        location: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        maxAssignees: { type: "number" },
        requiredBadges: { type: "array", items: { type: "string" } },
        startDate: { type: "string", description: "ISO start date." },
        deadline: { type: "string", description: "ISO deadline date." },
        payKind: {
          type: "string",
          enum: ["fixed", "hourly", "volunteer"],
          description: "Pay model; 'volunteer' mints a Thanks voucher per volunteer at completion. Omit for points-only.",
        },
        payAmountCents: { type: "number", description: "Fixed cash value in cents (payKind 'fixed')." },
        hourlyRateCents: { type: "number", description: "Hourly rate in cents (payKind 'hourly')." },
        maxHours: { type: "number", description: "Hour budget: hourly payout is clamped to this many hours." },
        points: { type: "number", description: "Job-level points for a task-less job (split at completion)." },
        claimApprovalRequired: { type: "boolean" },
        claimGateMembership: { type: "boolean" },
        claimGateAdmin: { type: "boolean" },
      },
    },
    run: (args) =>
      addJobToProjectAction(requireStr(args, "projectId"), {
        title: requireStr(args, "title"),
        description: str(args.description),
        category: str(args.category) ?? null,
        location: str(args.location) ?? null,
        priority:
          args.priority === "low" || args.priority === "medium" || args.priority === "high"
            ? args.priority
            : null,
        maxAssignees: num(args.maxAssignees) ?? null,
        requiredBadges: strArray(args.requiredBadges),
        startDate: optionalIsoDate(args, "startDate") ?? null,
        deadline: optionalIsoDate(args, "deadline") ?? null,
        maxHours: num(args.maxHours) ?? null,
        points: num(args.points) ?? null,
        payKind:
          args.payKind === "fixed" || args.payKind === "hourly" || args.payKind === "volunteer"
            ? args.payKind
            : null,
        payAmountCents: num(args.payAmountCents) ?? null,
        hourlyRateCents: num(args.hourlyRateCents) ?? null,
        claimApprovalRequired: args.claimApprovalRequired === true,
        claimGateMembership: args.claimGateMembership === true,
        claimGateAdmin: args.claimGateAdmin === true,
      }),
  },
  {
    name: "rivr.tasks.create",
    description:
      "Add a task to an EXISTING job (owner or group write/admin authority). Tasks carry the points that assignees " +
      "earn on completion; use this to populate jobs that shipped without tasks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId", "name"],
      properties: {
        jobId: { type: "string", description: "The job resource id to add the task under." },
        name: { type: "string" },
        description: { type: "string" },
        points: { type: "number", description: "Points earned when this task is completed (attested via the claim → attest rail)." },
        estimatedTime: { type: "string", description: "Human estimate, e.g. '2h'." },
        required: { type: "boolean", description: "Whether the task is required (default true)." },
        assignedTo: { type: "string", description: "Optional agent id to pre-assign." },
        startDate: { type: "string", description: "ISO start of the task's work window." },
        deadline: { type: "string", description: "ISO task deadline (the window's end)." },
        maxHours: { type: "number", description: "Advisory per-task hour budget (shown on the timesheet)." },
      },
    },
    run: (args) =>
      addTaskToJobAction(requireStr(args, "jobId"), {
        name: requireStr(args, "name"),
        description: str(args.description),
        points: num(args.points) ?? null,
        estimatedTime: str(args.estimatedTime) ?? null,
        required: args.required !== false,
        assignedTo: str(args.assignedTo) ?? null,
        startDate: optionalIsoDate(args, "startDate") ?? null,
        deadline: optionalIsoDate(args, "deadline") ?? null,
        maxHours: num(args.maxHours) ?? null,
      }),
  },
  {
    name: "rivr.projects.complete",
    description:
      "Complete a project and settle its treasury (group admin or project lead). Expenses are already " +
      "first-class debits, so the remaining project-wallet balance — the net — SWEEPS into the owning " +
      "group's treasury. Idempotent: a settled completion never moves money again. Run an explicit " +
      "net-distribution BEFORE completing when the net should split beyond the owning group.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectId"],
      properties: { projectId: { type: "string", description: "The project resource id to complete." } },
    },
    run: (args) => completeProjectAction(requireStr(args, "projectId")),
  },
  {
    name: "rivr.treasury.ensure_subgroup_wallets",
    description:
      "Guarantee a treasury (settlement wallet) for the group AND every descendant subgroup " +
      "(admin authority). Idempotent — reports created vs already-existing treasuries.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        groupId: { type: "string", description: "Root group. Defaults to the primary/acting group." },
      },
    },
    run: (args, ctx) => ensureSubgroupTreasuriesAction(str(args.groupId) ?? ctx.groupId),
  },
  {
    name: "rivr.jobs.mark_done",
    description:
      "Mark a job DONE and settle its compensation (owner or group admin authority). Flips the job to completed, " +
      "records a contribution for every assignee, and pays cash compensation (fixed split or hourly × tracked time) " +
      "from the group treasury wallet. Idempotent: re-run to retry payouts parked on an underfunded treasury.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: { jobId: { type: "string" } },
    },
    run: (args) => markJobDoneAction(requireStr(args, "jobId")),
  },
  {
    name: "rivr.treasury.crypto_overview",
    description:
      "Read the group's crypto (USDC on Base) treasury: whether an officer Safe is configured, its address, " +
      "officer set + threshold, on-chain USDC balance, whether the budget (Allowance) module is enabled, each active " +
      "per-lead budget with its remaining amount, and any pending officer-signature proposals. Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...GROUP_ID_PROP },
    },
    run: (args, ctx) => getCryptoTreasuryOverviewAction(pickGroup(args, ctx)),
  },
  {
    name: "rivr.treasury.crypto_propose_budget",
    description:
      "Create the officer-approval proposals for a per-lead USDC spending budget on the group's treasury Safe " +
      "(enable the budget module if needed, register the lead as a delegate, set the allowance). The officers then " +
      "sign the proposals in-app; the lead afterwards pays members within the budget with a single signature and no " +
      "officer involvement. Requires admin authority. Does NOT move money — it only creates the proposals to be signed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["leadAddress", "amountUsd"],
      properties: {
        ...GROUP_ID_PROP,
        leadAddress: { type: "string", description: "The budget lead's wallet address (0x…, 42 chars)." },
        amountUsd: { type: "number", description: "Budget size in US dollars, e.g. 250 for a $250 budget." },
        periodic: {
          type: "boolean",
          description: "true = the budget refills monthly; false (default) = a one-time depleting budget.",
        },
      },
    },
    run: (args, ctx) =>
      createBudgetProposalsAction(
        pickGroup(args, ctx),
        requireStr(args, "leadAddress"),
        Math.round((num(args.amountUsd) ?? 0) * 100),
        args.periodic === true ? 43200 : 0,
      ),
  },
  {
    name: "rivr.treasury.crypto_propose_transfer",
    description:
      "Create an officer-approval proposal for a direct USDC transfer out of the group's treasury Safe to an address. " +
      "Officers sign it in-app; the platform relayer executes at threshold. Requires admin authority. Creates the " +
      "proposal only — it does not move money until the officers sign.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["toAddress", "amountUsd"],
      properties: {
        ...GROUP_ID_PROP,
        toAddress: { type: "string", description: "Recipient wallet address (0x…, 42 chars)." },
        amountUsd: { type: "number", description: "Amount in US dollars, e.g. 50 for $50 USDC." },
      },
    },
    run: (args, ctx) =>
      createTransferProposalAction(
        pickGroup(args, ctx),
        requireStr(args, "toAddress"),
        Math.round((num(args.amountUsd) ?? 0) * 100),
      ),
  },
];

// ---------------------------------------------------------------------------
// Adapter: assistant native-chat toolset
// ---------------------------------------------------------------------------

export interface GroupActionToolset {
  tools: NativeChatToolSpec[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Build the group-action toolset for the assistant chat, bound to `groupId`.
 * Returns `null` when the caller may not act (mirrors the connector toolset gate).
 */
export function buildGroupActionToolset(input: {
  groupId: string;
  canAct: boolean;
}): GroupActionToolset | null {
  if (!input.canAct || !input.groupId) return null;
  const { groupId } = input;

  const tools: NativeChatToolSpec[] = GROUP_ACTION_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));

  async function executeTool(name: string, rawInput: Record<string, unknown>): Promise<unknown> {
    const tool = GROUP_ACTION_TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown group action tool "${name}".`);
    return tool.run(rawInput ?? {}, { groupId });
  }

  return { tools, executeTool };
}
