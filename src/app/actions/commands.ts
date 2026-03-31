"use server";

/**
 * @file Server action module for executing user-authenticated natural-language commands.
 * @description Exports `executeCommand`, which validates auth and input, delegates parsing/execution
 * to the NLP command layer, and returns structured success/error payloads for UI consumers.
 * @dependencies `@/auth`, `@/lib/nlp`, `next/cache`
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { parseCommand } from "@/lib/nlp";

/**
 * Execute a natural-language command for the current authenticated user.
 *
 * Authentication is required. This action uses a consistent error-return pattern:
 * failures return `{ success: false, message, error }` instead of throwing.
 *
 * @param {string} text - Raw command text entered by the user.
 * @returns {Promise<{
 *   success: boolean;
 *   message: string;
 *   data?: {
 *     targetAgent: string;
 *     amount: number;
 *     transactionId?: string;
 *   };
 *   error?: {
 *     code: string;
 *     details: string;
 *   };
 * }>} Parsed command result or structured failure payload.
 * @throws {never} This function catches unexpected runtime failures and returns a `SERVER_ERROR` payload.
 *
 * @example
 * const result = await executeCommand("pay alice 50 rivr");
 * if (!result.success && result.error?.code === "UNAUTHENTICATED") {
 *   // Prompt login before retrying command execution.
 * }
 */
export async function executeCommand(text: string): Promise<{
  success: boolean;
  message: string;
  data?: {
    targetAgent: string;
    amount: number;
    transactionId?: string;
  };
  error?: {
    code: string;
    details: string;
  };
}> {
  try {
    // Auth gate: commands may mutate state, so anonymous execution is blocked.
    const session = await auth();

    // Return a typed application error instead of throwing to simplify client handling.
    if (!session || !session.user || !session.user.id) {
      return {
        success: false,
        message: "You must be logged in to execute commands",
        error: {
          code: "UNAUTHENTICATED",
          details: "No valid session found",
        },
      };
    }

    // Validate command text early to avoid unnecessary parser/DB work.
    const MAX_COMMAND_TEXT_LENGTH = 2000;
    if (!text || typeof text !== "string" || !text.trim()) {
      return {
        success: false,
        message: "Invalid command: command text cannot be empty",
        error: {
          code: "INVALID_INPUT",
          details: "Command text is required",
        },
      };
    }
    if (text.length > MAX_COMMAND_TEXT_LENGTH) {
      return {
        success: false,
        message: `Command text exceeds maximum length of ${MAX_COMMAND_TEXT_LENGTH} characters.`,
        error: {
          code: "INVALID_INPUT",
          details: `Maximum command length is ${MAX_COMMAND_TEXT_LENGTH} characters`,
        },
      };
    }

    // Delegate command interpretation/execution to the NLP layer.
    const result = await parseCommand(session.user.id, text);

    // Refresh home data so command side effects are reflected immediately.
    revalidatePath("/");

    return result;
  } catch (error) {
    // Normalize unexpected exceptions into a stable API shape for the UI.
    return {
      success: false,
      message: "An unexpected error occurred while executing the command",
      error: {
        code: "SERVER_ERROR",
        details: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
