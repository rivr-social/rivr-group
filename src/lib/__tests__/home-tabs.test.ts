import { describe, expect, it } from "vitest"

import { ALLOWED_HOME_TABS, resolveHomeRedirectPath } from "@/lib/home-tabs"

const AGENT_ID = "7b1e7b32-117b-4082-a49b-f580d81516a5"

describe("resolveHomeRedirectPath", () => {
  it("redirects to the bare group page with no tab", () => {
    expect(resolveHomeRedirectPath(AGENT_ID)).toBe(`/groups/${AGENT_ID}`)
    expect(resolveHomeRedirectPath(AGENT_ID, null)).toBe(`/groups/${AGENT_ID}`)
    expect(resolveHomeRedirectPath(AGENT_ID, undefined)).toBe(`/groups/${AGENT_ID}`)
  })

  it("forwards every allowed tab", () => {
    for (const tab of ALLOWED_HOME_TABS) {
      expect(resolveHomeRedirectPath(AGENT_ID, tab)).toBe(
        `/groups/${AGENT_ID}?tab=${tab}`,
      )
    }
  })

  it("drops unknown or malicious tab values", () => {
    expect(resolveHomeRedirectPath(AGENT_ID, "nonsense")).toBe(`/groups/${AGENT_ID}`)
    expect(resolveHomeRedirectPath(AGENT_ID, "")).toBe(`/groups/${AGENT_ID}`)
    expect(resolveHomeRedirectPath(AGENT_ID, "feed&evil=1")).toBe(`/groups/${AGENT_ID}`)
    expect(resolveHomeRedirectPath(AGENT_ID, "../admin")).toBe(`/groups/${AGENT_ID}`)
  })
})
