"use server";

/**
 * Server actions for contract rule CRUD operations.
 *
 * Purpose:
 * - Create, list, toggle, and delete contract rules (visual agreements).
 * - Each rule defines a WHEN/THEN chain/IF pattern that auto-executes via the ledger engine.
 * - Actions are stored as a JSONB array supporting chained multi-step responses.
 * - Determiners (any, my, the, that) scope how each slot matches at runtime.
 *
 * Auth:
 * - All actions require an authenticated session.
 * - Mutations are scoped to the authenticated user's own rules.
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { contractRules } from "@/db/schema";
import type { ContractAction } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";

// ─── Auth Helper ─────────────────────────────────────────────────────────────

async function requireActorId(): Promise<string> {
  const session = await auth();
  const actorId = session?.user?.id;
  if (!actorId) {
    throw new Error("Unauthorized");
  }
  return actorId;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CreateContractRuleInput {
  name: string;
  scopeId?: string | null;

  // Trigger: WHEN [det] [who] [does what] [det] [what]
  triggerSubjectDeterminer?: string | null;
  triggerSubjectId?: string | null;
  triggerVerb?: string | null;
  triggerObjectDeterminer?: string | null;
  triggerObjectId?: string | null;

  // Actions: THEN chain — array of actions executed sequentially
  actions: ContractAction[];

  // Condition: IF [det] [who] [does what] [det] [what]
  conditionSubjectDeterminer?: string | null;
  conditionSubjectId?: string | null;
  conditionVerb?: string | null;
  conditionObjectDeterminer?: string | null;
  conditionObjectId?: string | null;

  maxFires?: number | null;
}

export interface ContractRuleRow {
  id: string;
  name: string;
  ownerId: string;
  scopeId: string | null;
  triggerSubjectDeterminer: string | null;
  triggerSubjectId: string | null;
  triggerVerb: string | null;
  triggerObjectDeterminer: string | null;
  triggerObjectId: string | null;
  actions: ContractAction[];
  conditionSubjectDeterminer: string | null;
  conditionSubjectId: string | null;
  conditionVerb: string | null;
  conditionObjectDeterminer: string | null;
  conditionObjectId: string | null;
  enabled: boolean;
  fireCount: number;
  maxFires: number | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

/**
 * Create a new contract rule owned by the current user.
 * Returns the created rule ID.
 */
export async function createContractRule(
  input: CreateContractRuleInput
): Promise<{ id: string } | { error: string }> {
  try {
    const ownerId = await requireActorId();

    // Validate required fields
    const MAX_CONTRACT_RULE_NAME_LENGTH = 500;
    if (!input.name || !input.name.trim()) {
      return { error: "Rule name is required" };
    }
    if (input.name.length > MAX_CONTRACT_RULE_NAME_LENGTH) {
      return { error: `Rule name exceeds maximum length of ${MAX_CONTRACT_RULE_NAME_LENGTH} characters.` };
    }
    if (!input.actions || input.actions.length === 0) {
      return { error: "At least one action is required" };
    }
    for (let i = 0; i < input.actions.length; i++) {
      if (!input.actions[i].verb || !input.actions[i].verb.trim()) {
        return { error: `Action ${i + 1} is missing a verb` };
      }
    }

    const [inserted] = await db
      .insert(contractRules)
      .values({
        name: input.name.trim(),
        ownerId,
        scopeId: input.scopeId ?? null,
        triggerSubjectDeterminer: input.triggerSubjectDeterminer ?? null,
        triggerSubjectId: input.triggerSubjectId ?? null,
        triggerVerb: input.triggerVerb ?? null,
        triggerObjectDeterminer: input.triggerObjectDeterminer ?? null,
        triggerObjectId: input.triggerObjectId ?? null,
        actions: input.actions,
        conditionSubjectDeterminer: input.conditionSubjectDeterminer ?? null,
        conditionSubjectId: input.conditionSubjectId ?? null,
        conditionVerb: input.conditionVerb ?? null,
        conditionObjectDeterminer: input.conditionObjectDeterminer ?? null,
        conditionObjectId: input.conditionObjectId ?? null,
        enabled: true,
        fireCount: 0,
        maxFires: input.maxFires ?? null,
      })
      .returning({ id: contractRules.id });

    return { id: inserted.id };
  } catch (error) {
    console.error("[contracts] createContractRule failed:", error);
    return { error: error instanceof Error ? error.message : "Failed to create rule" };
  }
}

/**
 * List all contract rules owned by the current user, newest first.
 */
export async function listMyContractRules(): Promise<ContractRuleRow[]> {
  try {
    const ownerId = await requireActorId();

    const rows = await db
      .select()
      .from(contractRules)
      .where(eq(contractRules.ownerId, ownerId))
      .orderBy(desc(contractRules.createdAt));

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      ownerId: r.ownerId,
      scopeId: r.scopeId,
      triggerSubjectDeterminer: r.triggerSubjectDeterminer,
      triggerSubjectId: r.triggerSubjectId,
      triggerVerb: r.triggerVerb,
      triggerObjectDeterminer: r.triggerObjectDeterminer,
      triggerObjectId: r.triggerObjectId,
      actions: r.actions ?? [],
      conditionSubjectDeterminer: r.conditionSubjectDeterminer,
      conditionSubjectId: r.conditionSubjectId,
      conditionVerb: r.conditionVerb,
      conditionObjectDeterminer: r.conditionObjectDeterminer,
      conditionObjectId: r.conditionObjectId,
      enabled: r.enabled,
      fireCount: r.fireCount,
      maxFires: r.maxFires,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  } catch (error) {
    console.error("[contracts] listMyContractRules failed:", error);
    return [];
  }
}

/**
 * Toggle a contract rule's enabled state. Only the owner can toggle.
 */
export async function toggleContractRule(
  ruleId: string,
  enabled: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    const ownerId = await requireActorId();

    const result = await db
      .update(contractRules)
      .set({ enabled, updatedAt: new Date() })
      .where(and(eq(contractRules.id, ruleId), eq(contractRules.ownerId, ownerId)))
      .returning({ id: contractRules.id });

    if (result.length === 0) {
      return { success: false, error: "Rule not found or not owned by you" };
    }

    return { success: true };
  } catch (error) {
    console.error("[contracts] toggleContractRule failed:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to toggle rule" };
  }
}

/**
 * Delete a contract rule. Only the owner can delete.
 */
export async function deleteContractRule(
  ruleId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const ownerId = await requireActorId();

    const result = await db
      .delete(contractRules)
      .where(and(eq(contractRules.id, ruleId), eq(contractRules.ownerId, ownerId)))
      .returning({ id: contractRules.id });

    if (result.length === 0) {
      return { success: false, error: "Rule not found or not owned by you" };
    }

    return { success: true };
  } catch (error) {
    console.error("[contracts] deleteContractRule failed:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to delete rule" };
  }
}
