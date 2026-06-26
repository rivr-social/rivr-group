/**
 * Public constant + type surface for the group-assistant-config server actions.
 *
 * Reason this file exists:
 * - `group-assistant-config.ts` is a `"use server"` file. Next.js 15 forbids a
 *   "use server" file from exporting anything other than async functions, so
 *   the allowed-model list (a runtime value) cannot be exported from there.
 * - Keeping the public surface here (no `"use server"` directive) lets the
 *   server-action code import from `./group-assistant-config-types`.
 *
 * Do not add runtime behavior to this file.
 */

/**
 * Models a group admin may select for the assistant. Restricting the set keeps
 * arbitrary/typo selectors out of the native-chat provider router.
 */
export const ALLOWED_ASSISTANT_MODELS = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-6",
  "openai/gpt-4o",
  "gemini/gemini-2.0-flash",
  "local/ollama",
] as const;

export type AllowedAssistantModel = (typeof ALLOWED_ASSISTANT_MODELS)[number];
