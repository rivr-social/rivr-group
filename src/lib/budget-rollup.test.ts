import { describe, expect, it } from "vitest"
import {
  computeProjectBudget,
  rollUpBudgets,
  type BudgetAgentNode,
  type ProjectBudgetSummary,
} from "@/lib/budget-rollup"

describe("computeProjectBudget", () => {
  it("sums committed vs spent across all four cost sources", () => {
    const summary = computeProjectBudget({
      projectId: "p1",
      projectName: "Build Shed",
      ownerAgentId: "g",
      budgetCents: 100000, // $1000 budget
      jobsCommittedCents: 40000, // $400 planned job cash
      jobsPaidCents: 15000, // $150 paid so far
      purchasesCents: 8000, // $80 supplies
      cardExpensesCents: 5000, // $50 on the card
      otherExpensesCents: 2000, // $20 external expense
    })

    // committed = 40000 + 8000 + 5000 + 2000
    expect(summary.committedCents).toBe(55000)
    // spent = 15000 + 8000 + 5000 + 2000
    expect(summary.spentCents).toBe(30000)
    expect(summary.remainingCents).toBe(100000 - 55000)
    expect(summary.overBudget).toBe(false)
  })

  it("flags over-budget when obligations exceed the target", () => {
    const summary = computeProjectBudget({
      projectId: "p1",
      projectName: "Overspend",
      ownerAgentId: "g",
      budgetCents: 10000,
      jobsCommittedCents: 12000,
      jobsPaidCents: 0,
      purchasesCents: 0,
      cardExpensesCents: 0,
      otherExpensesCents: 0,
    })
    expect(summary.overBudget).toBe(true)
    expect(summary.remainingCents).toBe(-2000)
  })

  it("returns null remaining when no budget is set, and clamps negatives to zero", () => {
    const summary = computeProjectBudget({
      projectId: "p1",
      projectName: "No budget",
      ownerAgentId: "g",
      budgetCents: null,
      jobsCommittedCents: -50, // garbage -> clamped to 0
      jobsPaidCents: 0,
      purchasesCents: 3000,
      cardExpensesCents: 0,
      otherExpensesCents: 0,
    })
    expect(summary.budgetCents).toBeNull()
    expect(summary.remainingCents).toBeNull()
    expect(summary.overBudget).toBe(false)
    expect(summary.components.jobsCommittedCents).toBe(0)
    expect(summary.committedCents).toBe(3000)
  })
})

describe("rollUpBudgets", () => {
  // Tree: group G -> subgroup S. Project p1 owned by G, project p2 owned by S.
  const agents: BudgetAgentNode[] = [
    { agentId: "G", agentName: "Spirit", parentId: null, kind: "group" },
    { agentId: "S", agentName: "Kitchen Circle", parentId: "G", kind: "subgroup" },
  ]

  const p1 = computeProjectBudget({
    projectId: "p1",
    projectName: "Group project",
    ownerAgentId: "G",
    budgetCents: 50000,
    jobsCommittedCents: 20000,
    jobsPaidCents: 10000,
    purchasesCents: 0,
    cardExpensesCents: 0,
    otherExpensesCents: 0,
  })
  const p2 = computeProjectBudget({
    projectId: "p2",
    projectName: "Subgroup project",
    ownerAgentId: "S",
    budgetCents: 30000,
    jobsCommittedCents: 5000,
    jobsPaidCents: 5000,
    purchasesCents: 1000,
    cardExpensesCents: 0,
    otherExpensesCents: 0,
  })
  const projects: ProjectBudgetSummary[] = [p1, p2]

  it("aggregates a subgroup's projects into the group total", () => {
    const root = rollUpBudgets(projects, agents, "G")
    expect(root).not.toBeNull()
    if (!root) return

    // Group node: its own project + the subgroup child.
    expect(root.directProjects).toHaveLength(1)
    expect(root.children).toHaveLength(1)

    // budget = 50000 (G) + 30000 (S) = 80000
    expect(root.totals.budgetCents).toBe(80000)
    // committed = 20000 (p1) + (5000 + 1000) (p2) = 26000
    expect(root.totals.committedCents).toBe(26000)
    // spent = 10000 (p1) + (5000 + 1000) (p2) = 16000
    expect(root.totals.spentCents).toBe(16000)
    expect(root.totals.remainingCents).toBe(80000 - 26000)

    // Subgroup child totals only cover p2.
    const child = root.children[0]
    expect(child.agentId).toBe("S")
    expect(child.totals.committedCents).toBe(6000)
    expect(child.totals.spentCents).toBe(6000)
    expect(child.totals.budgetCents).toBe(30000)
  })

  it("returns null when the root agent is not in the tree", () => {
    expect(rollUpBudgets(projects, agents, "missing")).toBeNull()
  })

  it("leaves budget null at a node whose subtree set no budgets", () => {
    const noBudgetProjects = [
      computeProjectBudget({
        projectId: "p3",
        projectName: "Unbudgeted",
        ownerAgentId: "G",
        budgetCents: null,
        jobsCommittedCents: 1000,
        jobsPaidCents: 0,
        purchasesCents: 0,
        cardExpensesCents: 0,
        otherExpensesCents: 0,
      }),
    ]
    const root = rollUpBudgets(noBudgetProjects, [agents[0]], "G")
    expect(root?.totals.budgetCents).toBeNull()
    expect(root?.totals.remainingCents).toBeNull()
    expect(root?.totals.committedCents).toBe(1000)
  })
})
