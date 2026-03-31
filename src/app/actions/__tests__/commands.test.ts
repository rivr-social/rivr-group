import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.fn();
const mockParseCommand = vi.fn();
const mockRevalidatePath = vi.fn();

vi.mock("@/auth", () => ({
  auth: () => mockAuth(),
}));

vi.mock("@/lib/nlp", () => ({
  parseCommand: (...args: unknown[]) => mockParseCommand(...args),
}));

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

import { executeCommand } from "../commands";

const USER_ID = "user-123";

const DEFAULT_PARSE_RESULT = {
  success: true,
  message: "Command executed",
};

describe("executeCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: USER_ID } });
    mockParseCommand.mockResolvedValue(DEFAULT_PARSE_RESULT);
  });

  // ── Authentication checks ──────────────────────────────────────────

  describe("authentication", () => {
    it("returns UNAUTHENTICATED error when session is null", async () => {
      mockAuth.mockResolvedValueOnce(null);

      const result = await executeCommand("pay alice 50");

      expect(result).toEqual({
        success: false,
        message: "You must be logged in to execute commands",
        error: {
          code: "UNAUTHENTICATED",
          details: "No valid session found",
        },
      });
      expect(mockParseCommand).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it("returns UNAUTHENTICATED error when session.user is missing", async () => {
      mockAuth.mockResolvedValueOnce({ user: undefined });

      const result = await executeCommand("pay alice 50");

      expect(result).toEqual({
        success: false,
        message: "You must be logged in to execute commands",
        error: {
          code: "UNAUTHENTICATED",
          details: "No valid session found",
        },
      });
      expect(mockParseCommand).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it("returns UNAUTHENTICATED error when session.user.id is missing", async () => {
      mockAuth.mockResolvedValueOnce({ user: { id: undefined } });

      const result = await executeCommand("pay alice 50");

      expect(result).toEqual({
        success: false,
        message: "You must be logged in to execute commands",
        error: {
          code: "UNAUTHENTICATED",
          details: "No valid session found",
        },
      });
      expect(mockParseCommand).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });
  });

  // ── Input validation ───────────────────────────────────────────────

  describe("input validation", () => {
    it("returns INVALID_INPUT error when text is an empty string", async () => {
      const result = await executeCommand("");

      expect(result).toEqual({
        success: false,
        message: "Invalid command: command text cannot be empty",
        error: {
          code: "INVALID_INPUT",
          details: "Command text is required",
        },
      });
      expect(mockParseCommand).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it("returns INVALID_INPUT error when text is whitespace only", async () => {
      const result = await executeCommand("   \t\n  ");

      expect(result).toEqual({
        success: false,
        message: "Invalid command: command text cannot be empty",
        error: {
          code: "INVALID_INPUT",
          details: "Command text is required",
        },
      });
      expect(mockParseCommand).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it("returns INVALID_INPUT error when text is null or undefined cast as string", async () => {
      const result = await executeCommand(
        null as unknown as string
      );

      expect(result).toEqual({
        success: false,
        message: "Invalid command: command text cannot be empty",
        error: {
          code: "INVALID_INPUT",
          details: "Command text is required",
        },
      });
      expect(mockParseCommand).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });
  });

  // ── Successful execution ───────────────────────────────────────────

  describe("successful command execution", () => {
    it("passes userId and text to parseCommand, revalidates path, and returns result", async () => {
      const commandText = "pay alice 50";

      const result = await executeCommand(commandText);

      expect(mockParseCommand).toHaveBeenCalledTimes(1);
      expect(mockParseCommand).toHaveBeenCalledWith(USER_ID, commandText);
      expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
      expect(mockRevalidatePath).toHaveBeenCalledWith("/");
      expect(result).toEqual(DEFAULT_PARSE_RESULT);
    });

    it("forwards the data field when parseCommand returns data", async () => {
      const parseResultWithData = {
        success: true,
        message: "Payment sent to alice",
        data: {
          targetAgent: "alice",
          amount: 50,
          transactionId: "txn-abc-123",
        },
      };
      mockParseCommand.mockResolvedValueOnce(parseResultWithData);

      const result = await executeCommand("pay alice 50");

      expect(result).toEqual(parseResultWithData);
      expect(result.data).toEqual({
        targetAgent: "alice",
        amount: 50,
        transactionId: "txn-abc-123",
      });
      expect(mockRevalidatePath).toHaveBeenCalledWith("/");
    });
  });

  // ── Error handling ─────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns SERVER_ERROR with error message when parseCommand throws an Error", async () => {
      mockParseCommand.mockRejectedValueOnce(
        new Error("Database connection lost")
      );

      const result = await executeCommand("pay alice 50");

      expect(result).toEqual({
        success: false,
        message:
          "An unexpected error occurred while executing the command",
        error: {
          code: "SERVER_ERROR",
          details: "Database connection lost",
        },
      });
    });

    it("returns SERVER_ERROR with stringified value when parseCommand throws a non-Error", async () => {
      mockParseCommand.mockRejectedValueOnce("unexpected string error");

      const result = await executeCommand("pay alice 50");

      expect(result).toEqual({
        success: false,
        message:
          "An unexpected error occurred while executing the command",
        error: {
          code: "SERVER_ERROR",
          details: "unexpected string error",
        },
      });
    });
  });
});
