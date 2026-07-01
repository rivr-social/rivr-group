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
} from "@/app/actions/resource-creation";
import { updateTaskStatus, claimTasksAction } from "@/app/actions/interactions/tasks";
import {
  claimJobAction,
  recordJobContributionAction,
} from "@/app/actions/interactions/project-team";

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

function strArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
    : [];
}

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
        title: { type: "string" },
        description: { type: "string" },
        category: { type: "string", description: "Project category, e.g. 'events', 'operations'." },
        deadline: { type: "string", description: "ISO date/time the project is due." },
        budget: { type: "number", description: "Optional budget amount." },
        jobs: {
          type: "array",
          description:
            "Optional jobs to create under the project. Each job may carry its own tasks.",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["title", "description"],
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              category: { type: "string" },
              maxAssignees: { type: "number" },
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
    run: (args, { groupId }) =>
      createProjectResource({
        title: requireStr(args, "title"),
        description: requireStr(args, "description"),
        category: requireStr(args, "category"),
        groupId,
        deadline: str(args.deadline),
        budget: num(args.budget) ?? null,
        jobs: Array.isArray(args.jobs) ? (args.jobs as unknown[]) : undefined,
      }),
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
    run: (args, { groupId }) =>
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
        ownerId: groupId,
      }),
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
    run: (args, { groupId }) =>
      createOfferingResource({
        title: requireStr(args, "title"),
        description: requireStr(args, "description"),
        offeringType: requireStr(args, "offeringType"),
        basePrice: num(args.basePrice),
        currency: str(args.currency),
        quantityAvailable: num(args.quantityAvailable),
        category: str(args.category),
        imageUrl: str(args.imageUrl),
        tags: strArray(args.tags),
        targetAgentTypes: ["person"],
        ownerId: groupId,
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
        title: { type: "string" },
        content: { type: "string", description: "Markdown body of the document." },
        description: { type: "string" },
        category: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        showOnAbout: { type: "boolean" },
      },
    },
    run: (args, { groupId }) =>
      createDocumentResourceAction({
        groupId,
        title: requireStr(args, "title"),
        content: str(args.content),
        description: str(args.description),
        category: str(args.category),
        tags: strArray(args.tags),
        showOnAbout: args.showOnAbout === true,
      }),
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
