/**
 * Project budgeting rollup (2026-07-14, backlog B14).
 *
 * A project's real budget picture aggregates three spend sources plus its
 * authored target:
 *   (a) JOB COSTS — cash the project owes its workers: `committed` (planned
 *       fixed pay + the hourly ceiling of every job) vs `paid` (what
 *       `markJobDoneAction` has actually settled out of the project wallet).
 *   (b) PURCHASES — products/supplies bought FOR the project on-platform
 *       (Needs / shopping-list buys attributed to the project).
 *   (c) CARD EXPENSES — spend on the project's FinancialAccount-scoped Issuing
 *       card, plus any first-class external project expenses.
 *
 * Those per-project summaries then ROLL UP: a project's numbers fold into its
 * owning subgroup, subgroups into the group, and a child group into its parent
 * group (recursive `agents.parent_id`).
 *
 * This module is the PURE, DB-free core so the money math is unit-testable and
 * feeds BOTH the project page and the treasury page from one source of truth.
 * All amounts are integer cents.
 */

// ---------------------------------------------------------------------------
// Per-project
// ---------------------------------------------------------------------------

/** Raw cost components gathered for a single project (all integer cents). */
export interface ProjectCostInputs {
  projectId: string;
  projectName: string;
  /** The group/subgroup agent that owns the project (payout authority anchor). */
  ownerAgentId: string;
  /** Authored budget target, or `null` when none has been set. */
  budgetCents: number | null;
  /** Planned cash across the project's jobs (fixed pay + hourly ceilings). */
  jobsCommittedCents: number;
  /** Cash already paid out to workers from the project wallet. */
  jobsPaidCents: number;
  /** On-platform purchases attributed to the project. */
  purchasesCents: number;
  /** Spend on the project's FA-scoped Issuing card. */
  cardExpensesCents: number;
  /** First-class external project expenses (recordProjectExpense debits). */
  otherExpensesCents: number;
}

/** The individual spend components of a project budget summary. */
export interface ProjectBudgetComponents {
  jobsCommittedCents: number;
  jobsPaidCents: number;
  purchasesCents: number;
  cardExpensesCents: number;
  otherExpensesCents: number;
}

/** A single project's computed budget position. */
export interface ProjectBudgetSummary {
  projectId: string;
  projectName: string;
  ownerAgentId: string;
  budgetCents: number | null;
  /** Total OBLIGATIONS: committed job cash + purchases + card + other expenses. */
  committedCents: number;
  /** Actual money OUT: paid job cash + purchases + card + other expenses. */
  spentCents: number;
  /** `budgetCents - committedCents`, or `null` when no budget is set. */
  remainingCents: number | null;
  /** True when a budget is set and obligations exceed it. */
  overBudget: boolean;
  components: ProjectBudgetComponents;
}

/** Coerces a possibly-missing/negative cents value to a non-negative integer. */
function cents(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

/**
 * Computes a single project's budget position from its raw cost components.
 * `committed` = obligations (planned job cash + purchases + card + other);
 * `spent` = actual cash out (paid job cash + purchases + card + other).
 */
export function computeProjectBudget(input: ProjectCostInputs): ProjectBudgetSummary {
  const components: ProjectBudgetComponents = {
    jobsCommittedCents: cents(input.jobsCommittedCents),
    jobsPaidCents: cents(input.jobsPaidCents),
    purchasesCents: cents(input.purchasesCents),
    cardExpensesCents: cents(input.cardExpensesCents),
    otherExpensesCents: cents(input.otherExpensesCents),
  };

  const nonJob = components.purchasesCents + components.cardExpensesCents + components.otherExpensesCents;
  const committedCents = components.jobsCommittedCents + nonJob;
  const spentCents = components.jobsPaidCents + nonJob;

  const budgetCents = typeof input.budgetCents === 'number' && Number.isFinite(input.budgetCents)
    ? Math.max(0, Math.round(input.budgetCents))
    : null;
  const remainingCents = budgetCents === null ? null : budgetCents - committedCents;
  const overBudget = budgetCents !== null && committedCents > budgetCents;

  return {
    projectId: input.projectId,
    projectName: input.projectName,
    ownerAgentId: input.ownerAgentId,
    budgetCents,
    committedCents,
    spentCents,
    remainingCents,
    overBudget,
    components,
  };
}

// ---------------------------------------------------------------------------
// Rollup (project -> subgroup -> group -> parent group)
// ---------------------------------------------------------------------------

/** A node in the agent tree the rollup walks. */
export interface BudgetAgentNode {
  agentId: string;
  agentName: string;
  parentId: string | null;
  /** 'group' for the root, 'subgroup' for descendants (display only). */
  kind: 'group' | 'subgroup';
}

/** Aggregated budget totals (project components summed). */
export interface BudgetTotals {
  budgetCents: number | null;
  committedCents: number;
  spentCents: number;
  remainingCents: number | null;
  overBudget: boolean;
  components: ProjectBudgetComponents;
}

/** An agent (group/subgroup) with its own projects + aggregated descendants. */
export interface BudgetRollupNode {
  agentId: string;
  agentName: string;
  kind: 'group' | 'subgroup';
  /** Projects owned directly by THIS agent. */
  directProjects: ProjectBudgetSummary[];
  /** Child subgroup rollups. */
  children: BudgetRollupNode[];
  /** Totals across this agent's own projects AND every descendant. */
  totals: BudgetTotals;
}

function emptyComponents(): ProjectBudgetComponents {
  return {
    jobsCommittedCents: 0,
    jobsPaidCents: 0,
    purchasesCents: 0,
    cardExpensesCents: 0,
    otherExpensesCents: 0,
  };
}

function addComponents(a: ProjectBudgetComponents, b: ProjectBudgetComponents): ProjectBudgetComponents {
  return {
    jobsCommittedCents: a.jobsCommittedCents + b.jobsCommittedCents,
    jobsPaidCents: a.jobsPaidCents + b.jobsPaidCents,
    purchasesCents: a.purchasesCents + b.purchasesCents,
    cardExpensesCents: a.cardExpensesCents + b.cardExpensesCents,
    otherExpensesCents: a.otherExpensesCents + b.otherExpensesCents,
  };
}

/**
 * Rolls per-project budget summaries up an agent tree rooted at `rootAgentId`.
 * Each node's totals aggregate its OWN projects plus every descendant node,
 * so the group node reflects the entire subtree. A budget target is summed
 * only from the projects that set one (a node's `budgetCents` is `null` when no
 * project under it has a budget).
 *
 * @param projects - Every project summary in the tree (each carries `ownerAgentId`).
 * @param agents - The agent tree (root + descendants); the root should be the group.
 * @param rootAgentId - The group agent id to build the tree from.
 * @returns The root rollup node, or `null` when `rootAgentId` is not in `agents`.
 */
export function rollUpBudgets(
  projects: readonly ProjectBudgetSummary[],
  agents: readonly BudgetAgentNode[],
  rootAgentId: string,
): BudgetRollupNode | null {
  const agentById = new Map(agents.map((a) => [a.agentId, a]));
  if (!agentById.has(rootAgentId)) return null;

  const childrenByParent = new Map<string, BudgetAgentNode[]>();
  for (const agent of agents) {
    if (agent.parentId && agent.agentId !== rootAgentId) {
      const list = childrenByParent.get(agent.parentId) ?? [];
      list.push(agent);
      childrenByParent.set(agent.parentId, list);
    }
  }

  const projectsByOwner = new Map<string, ProjectBudgetSummary[]>();
  for (const project of projects) {
    const list = projectsByOwner.get(project.ownerAgentId) ?? [];
    list.push(project);
    projectsByOwner.set(project.ownerAgentId, list);
  }

  const build = (agent: BudgetAgentNode): BudgetRollupNode => {
    const directProjects = projectsByOwner.get(agent.agentId) ?? [];
    const children = (childrenByParent.get(agent.agentId) ?? []).map(build);

    let components = emptyComponents();
    let budgetCents: number | null = null;

    for (const project of directProjects) {
      components = addComponents(components, project.components);
      if (project.budgetCents !== null) {
        budgetCents = (budgetCents ?? 0) + project.budgetCents;
      }
    }
    for (const child of children) {
      components = addComponents(components, child.totals.components);
      if (child.totals.budgetCents !== null) {
        budgetCents = (budgetCents ?? 0) + child.totals.budgetCents;
      }
    }

    const nonJob = components.purchasesCents + components.cardExpensesCents + components.otherExpensesCents;
    const committedCents = components.jobsCommittedCents + nonJob;
    const spentCents = components.jobsPaidCents + nonJob;
    const remainingCents = budgetCents === null ? null : budgetCents - committedCents;
    const overBudget = budgetCents !== null && committedCents > budgetCents;

    return {
      agentId: agent.agentId,
      agentName: agent.agentName,
      kind: agent.kind,
      directProjects,
      children,
      totals: { budgetCents, committedCents, spentCents, remainingCents, overBudget, components },
    };
  };

  return build(agentById.get(rootAgentId) as BudgetAgentNode);
}
