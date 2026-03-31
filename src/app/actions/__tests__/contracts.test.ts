import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";

// =============================================================================
// Mocks
// =============================================================================

vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("next/headers", async () => {
  const { setupNextHeadersMock } = await import("@/test/external-mocks");
  return setupNextHeadersMock();
});

vi.mock("next/cache", async () => {
  const { setupNextCacheMock } = await import("@/test/external-mocks");
  return setupNextCacheMock();
});

// Import AFTER all mocks
import { auth } from "@/auth";
import {
  createContractRule,
  listMyContractRules,
  toggleContractRule,
  deleteContractRule,
} from "../contracts";
import type { CreateContractRuleInput, ContractAction } from "../contracts";

// =============================================================================
// Constants
// =============================================================================

const MAX_CONTRACT_RULE_NAME_LENGTH = 500;

const VALID_ACTION: ContractAction = {
  verb: "grant",
  subjectDeterminer: "the",
  subjectId: null,
  objectDeterminer: "any",
  objectId: null,
};

const VALID_INPUT: CreateContractRuleInput = {
  name: "Test Rule",
  actions: [VALID_ACTION],
};

// =============================================================================
// Tests
// =============================================================================

describe("contracts actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // createContractRule
  // ===========================================================================

  describe("createContractRule", () => {
    it("throws when user is not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(createContractRule(VALID_INPUT)).rejects.toThrow("Unauthorized");
      }));

    it("returns error when name is empty", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createContractRule({ ...VALID_INPUT, name: "" });

        expect(result).toEqual({ error: "Rule name is required" });
      }));

    it("returns error when name is only whitespace", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createContractRule({ ...VALID_INPUT, name: "   " });

        expect(result).toEqual({ error: "Rule name is required" });
      }));

    it("returns error when name exceeds max length", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const longName = "A".repeat(MAX_CONTRACT_RULE_NAME_LENGTH + 1);
        const result = await createContractRule({ ...VALID_INPUT, name: longName });

        expect(result).toEqual({
          error: `Rule name exceeds maximum length of ${MAX_CONTRACT_RULE_NAME_LENGTH} characters.`,
        });
      }));

    it("returns error when actions array is empty", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createContractRule({ ...VALID_INPUT, actions: [] });

        expect(result).toEqual({ error: "At least one action is required" });
      }));

    it("returns error when an action is missing a verb", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const badAction = { ...VALID_ACTION, verb: "" };
        const result = await createContractRule({
          ...VALID_INPUT,
          actions: [badAction] as ContractAction[],
        });

        expect(result).toEqual({ error: "Action 1 is missing a verb" });
      }));

    it("creates a contract rule and returns its id", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createContractRule(VALID_INPUT);

        expect(result).toHaveProperty("id");
        expect(typeof (result as { id: string }).id).toBe("string");
      }));

    it("trims the rule name before storing", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createContractRule({
          ...VALID_INPUT,
          name: "  Trimmed Rule  ",
        });

        expect(result).toHaveProperty("id");

        const rules = await listMyContractRules();
        const created = rules.find((r) => r.id === (result as { id: string }).id);
        expect(created?.name).toBe("Trimmed Rule");
      }));

    it("stores optional trigger and condition fields", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const input: CreateContractRuleInput = {
          ...VALID_INPUT,
          triggerSubjectDeterminer: "any",
          triggerVerb: "join",
          conditionVerb: "belong",
          maxFires: 5,
        };

        const result = await createContractRule(input);
        expect(result).toHaveProperty("id");

        const rules = await listMyContractRules();
        const created = rules.find((r) => r.id === (result as { id: string }).id);
        expect(created?.triggerSubjectDeterminer).toBe("any");
        expect(created?.triggerVerb).toBe("join");
        expect(created?.conditionVerb).toBe("belong");
        expect(created?.maxFires).toBe(5);
        expect(created?.enabled).toBe(true);
        expect(created?.fireCount).toBe(0);
      }));
  });

  // ===========================================================================
  // listMyContractRules
  // ===========================================================================

  describe("listMyContractRules", () => {
    it("returns empty array when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        // requireActorId throws, which is caught and returns []
        const result = await listMyContractRules();
        expect(result).toEqual([]);
      }));

    it("returns empty array when user has no rules", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await listMyContractRules();
        expect(result).toEqual([]);
      }));

    it("returns only rules owned by the current user", () =>
      withTestTransaction(async (db) => {
        const user1 = await createTestAgent(db);
        const user2 = await createTestAgent(db);

        // Create a rule for user1
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user1.id));
        await createContractRule({ ...VALID_INPUT, name: "User1 Rule" });

        // Create a rule for user2
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user2.id));
        await createContractRule({ ...VALID_INPUT, name: "User2 Rule" });

        // List as user1
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user1.id));
        const rules = await listMyContractRules();

        expect(rules.length).toBe(1);
        expect(rules[0].name).toBe("User1 Rule");
      }));

    it("returns rules in newest-first order", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await createContractRule({ ...VALID_INPUT, name: "First" });
        await createContractRule({ ...VALID_INPUT, name: "Second" });

        const rules = await listMyContractRules();
        expect(rules.length).toBe(2);
        expect(rules[0].name).toBe("Second");
        expect(rules[1].name).toBe("First");
      }));

    it("serializes dates to ISO strings", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await createContractRule(VALID_INPUT);
        const rules = await listMyContractRules();

        expect(rules[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(rules[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }));
  });

  // ===========================================================================
  // toggleContractRule
  // ===========================================================================

  describe("toggleContractRule", () => {
    it("throws when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(toggleContractRule("fake-id", false)).rejects.toThrow("Unauthorized");
      }));

    it("returns error when rule does not exist", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await toggleContractRule("00000000-0000-0000-0000-000000000000", false);
        expect(result).toEqual({
          success: false,
          error: "Rule not found or not owned by you",
        });
      }));

    it("returns error when rule is owned by different user", () =>
      withTestTransaction(async (db) => {
        const owner = await createTestAgent(db);
        const other = await createTestAgent(db);

        vi.mocked(auth).mockResolvedValue(mockAuthSession(owner.id));
        const created = await createContractRule(VALID_INPUT);
        const ruleId = (created as { id: string }).id;

        vi.mocked(auth).mockResolvedValue(mockAuthSession(other.id));
        const result = await toggleContractRule(ruleId, false);
        expect(result).toEqual({
          success: false,
          error: "Rule not found or not owned by you",
        });
      }));

    it("disables an enabled rule", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const created = await createContractRule(VALID_INPUT);
        const ruleId = (created as { id: string }).id;

        const result = await toggleContractRule(ruleId, false);
        expect(result).toEqual({ success: true });

        const rules = await listMyContractRules();
        expect(rules[0].enabled).toBe(false);
      }));

    it("enables a disabled rule", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const created = await createContractRule(VALID_INPUT);
        const ruleId = (created as { id: string }).id;

        await toggleContractRule(ruleId, false);
        const result = await toggleContractRule(ruleId, true);
        expect(result).toEqual({ success: true });

        const rules = await listMyContractRules();
        expect(rules[0].enabled).toBe(true);
      }));
  });

  // ===========================================================================
  // deleteContractRule
  // ===========================================================================

  describe("deleteContractRule", () => {
    it("throws when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(deleteContractRule("fake-id")).rejects.toThrow("Unauthorized");
      }));

    it("returns error when rule does not exist", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await deleteContractRule("00000000-0000-0000-0000-000000000000");
        expect(result).toEqual({
          success: false,
          error: "Rule not found or not owned by you",
        });
      }));

    it("returns error when deleting another users rule", () =>
      withTestTransaction(async (db) => {
        const owner = await createTestAgent(db);
        const other = await createTestAgent(db);

        vi.mocked(auth).mockResolvedValue(mockAuthSession(owner.id));
        const created = await createContractRule(VALID_INPUT);
        const ruleId = (created as { id: string }).id;

        vi.mocked(auth).mockResolvedValue(mockAuthSession(other.id));
        const result = await deleteContractRule(ruleId);
        expect(result).toEqual({
          success: false,
          error: "Rule not found or not owned by you",
        });
      }));

    it("deletes own rule and removes it from listing", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const created = await createContractRule(VALID_INPUT);
        const ruleId = (created as { id: string }).id;

        const result = await deleteContractRule(ruleId);
        expect(result).toEqual({ success: true });

        const rules = await listMyContractRules();
        expect(rules.length).toBe(0);
      }));
  });
});
