/**
 * @file Member email-notification preference gate.
 * @description Shared, single-source predicate for a member's global email
 * opt-out. A member turns email notifications OFF in `/settings` → Notifications;
 * that preference is persisted on the agent row's `metadata`. Any outbound
 * member communication that respects the opt-out (group broadcasts, newsletters)
 * MUST route its recipient set through {@link isEmailEnabled} so there is ONE
 * implementation of the semantics.
 *
 * Preference resolution (in order):
 * 1. `metadata.emailNotifications` (top-level boolean) — honored if boolean.
 * 2. `metadata.notificationSettings.emailNotifications` (nested boolean) —
 *    honored if boolean.
 * 3. Otherwise the preference is considered UNSET and defaults to enabled.
 *
 * @dependencies none — pure predicate over an opaque metadata value.
 */

/**
 * Determines whether a member has email notifications enabled.
 *
 * Defaults to `true` (opted IN) when the preference is unset or the metadata
 * shape is not a plain object — an explicit `false` at either the top level or
 * the nested `notificationSettings` is the only way to opt OUT.
 *
 * @param metadata - The agent row's `metadata` value (opaque; may be null).
 * @returns `true` when email notifications are enabled, `false` when explicitly disabled.
 */
export function isEmailEnabled(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return true;
  }

  const record = metadata as Record<string, unknown>;
  const topLevel = record.emailNotifications;
  if (typeof topLevel === "boolean") {
    return topLevel;
  }

  const notificationSettings = record.notificationSettings;
  if (
    notificationSettings &&
    typeof notificationSettings === "object" &&
    !Array.isArray(notificationSettings)
  ) {
    const nested = (notificationSettings as Record<string, unknown>)
      .emailNotifications;
    if (typeof nested === "boolean") {
      return nested;
    }
  }

  return true;
}
