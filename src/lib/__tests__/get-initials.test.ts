import { describe, it, expect } from "vitest"
import { getInitials } from "@/lib/utils"

/**
 * `getInitials` backs the Job → About → Team Members avatar fallback. Once
 * assignee agent ids are resolved to display names server-side, a claimant
 * renders as "Bob Smith" with initials "BS" instead of a raw UUID. These cases
 * pin that behavior (and the id-only fallback used when no agent row exists).
 */
describe("getInitials", () => {
  it("takes first + last initial for a multi-word name", () => {
    expect(getInitials("Bob Smith")).toBe("BS")
    expect(getInitials("Ada Grace Lovelace")).toBe("AL")
  })

  it("takes the first two letters of a single-word name", () => {
    expect(getInitials("Bob")).toBe("BO")
  })

  it("returns a placeholder for an empty label", () => {
    expect(getInitials("")).toBe("??")
  })

  it("degrades gracefully when only a raw agent id is available (no agent row)", () => {
    // Fallback path: `assigneeNames[id] ?? id` yields the id, so initials come
    // from the id — the pre-fix behavior, now confined to missing-agent cases.
    expect(getInitials("b3a639d1-1234-5678-9abc-def012345678")).toBe("B3")
  })
})
