import { beforeEach, describe, expect, it, vi } from "vitest"

const findFirstAgent = vi.fn()
const findFirstResource = vi.fn()

vi.mock("@/db", () => ({
  db: {
    query: {
      agents: {
        findFirst: findFirstAgent,
      },
      resources: {
        findFirst: findFirstResource,
      },
    },
  },
}))

vi.mock("@/lib/graph-adapters", () => ({
  agentToUser: vi.fn(() => ({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Alex River",
    username: "alex",
    bio: "Community builder",
    avatar: "/avatar.png",
    chapterTags: ["boulder"],
    skills: ["coordination"],
  })),
  agentToGroup: vi.fn(() => ({
    id: "22222222-2222-4222-8222-222222222222",
    name: "River Ring",
    description: "A regenerative ring",
    image: "/ring.png",
    chapterTags: ["boulder"],
    tags: ["ecology"],
    website: "https://ring.example",
  })),
  agentToEvent: vi.fn(),
  resourceToMarketplaceListing: vi.fn(),
  resourceToPost: vi.fn(),
}))

vi.mock("@/lib/graph-serializers", () => ({
  serializeAgent: vi.fn((agent) => agent),
  serializeResource: vi.fn((resource) => resource),
}))

describe("universal-manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("builds a v0.1 person manifest shape", async () => {
    findFirstAgent.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      type: "person",
      visibility: "public",
      deletedAt: null,
      metadata: {
        username: "alex",
        murmurationsPublishing: true,
        website: "https://alex.example",
        activityPubActor: "https://fed.example/users/alex",
      },
    })

    const { buildPersonUniversalManifest } = await import("../universal-manifest")
    const manifest = await buildPersonUniversalManifest("11111111-1111-4111-8111-111111111111")

    expect(manifest).toMatchObject({
      "@context": "https://universalmanifest.net/ns/universal-manifest/v0.1/schema.jsonld",
      "@id": "urn:uuid:11111111-1111-4111-8111-111111111111",
      "@type": "um:Manifest",
      manifestVersion: "0.1",
      subject: expect.stringContaining("/profile/alex"),
      claims: expect.arrayContaining([
        expect.objectContaining({ name: "role", value: "person" }),
      ]),
      consents: expect.arrayContaining([
        expect.objectContaining({ name: "publicDisplay", value: true }),
      ]),
      shards: expect.arrayContaining([
        expect.objectContaining({ name: "publicProfile" }),
      ]),
      pointers: expect.arrayContaining([
        expect.objectContaining({ name: "universalManifest.current" }),
        expect.objectContaining({ name: "activityPub.actor", value: "https://fed.example/users/alex" }),
      ]),
    })
  })
})
