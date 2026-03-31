/**
 * Test fixture factory functions.
 *
 * Each factory inserts a real row into the database and returns the created record.
 * All factories accept a Drizzle database instance (use the one from withTestTransaction).
 */

import { agents, resources, ledger, wallets, nodes, nodePeers, federationEvents, subscriptions, emailVerificationTokens } from "@/db/schema";
import type {
  NewAgent,
  NewResource,
  NewLedgerEntry,
  NewWalletRecord,
  NewNodeRecord,
  NewNodePeerRecord,
  NewFederationEventRecord,
  NewSubscription,
  AgentType,
  ResourceType,
  VerbType,
  VisibilityLevel,
} from "@/db/schema";
import type { TestDatabase } from "./db";

// ---------------------------------------------------------------------------
// Pre-computed constants
// ---------------------------------------------------------------------------

/** Bcrypt hash of "TestPassword123" at cost 12 — avoids hashing in every test */
export const TEST_PASSWORD_HASH =
  "$2y$12$.PecUhZQCpq/aEEDb12UI.nhqCRu9Zcxb3VnhhMldpbiGz3MM.jAC";

/** Default password for test users */
export const TEST_PASSWORD = "TestPassword123";

// ---------------------------------------------------------------------------
// Counter for unique names/emails
// ---------------------------------------------------------------------------

let fixtureCounter = 0;

/**
 * Returns a monotonically increasing integer for generating unique
 * names, emails, and slugs within a single test process.
 *
 * @returns The next unique fixture counter value.
 */
function nextId(): number {
  return ++fixtureCounter;
}

// ---------------------------------------------------------------------------
// Agent fixtures
// ---------------------------------------------------------------------------

/**
 * Inserts a test person agent into the database.
 *
 * @param db - Transaction-scoped Drizzle instance from `withTestTransaction`.
 * @param overrides - Optional field overrides merged on top of defaults.
 * @returns The fully inserted agent row.
 *
 * @example
 * ```ts
 * const user = await createTestAgent(db, { name: "Alice" });
 * ```
 */
export async function createTestAgent(
  db: TestDatabase,
  overrides: Partial<NewAgent> = {}
): Promise<typeof agents.$inferSelect> {
  const n = nextId();
  const [agent] = await db
    .insert(agents)
    .values({
      name: `Test User ${n}`,
      type: "person" as AgentType,
      email: `testuser${n}@test.local`,
      passwordHash: TEST_PASSWORD_HASH,
      visibility: "public" as VisibilityLevel,
      metadata: {},
      ...overrides,
    } as NewAgent)
    .returning();
  return agent;
}

/**
 * Inserts a test organization (group) agent into the database.
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param overrides - Optional field overrides.
 * @returns The inserted organization agent row.
 */
export async function createTestGroup(
  db: TestDatabase,
  overrides: Partial<NewAgent> = {}
): Promise<typeof agents.$inferSelect> {
  const n = nextId();
  const [group] = await db
    .insert(agents)
    .values({
      name: `Test Group ${n}`,
      type: "organization" as AgentType,
      visibility: "public" as VisibilityLevel,
      metadata: {},
      ...overrides,
    } as NewAgent)
    .returning();
  return group;
}

/**
 * Inserts a test event agent into the database.
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param overrides - Optional field overrides.
 * @returns The inserted event agent row.
 */
export async function createTestEvent(
  db: TestDatabase,
  overrides: Partial<NewAgent> = {}
): Promise<typeof agents.$inferSelect> {
  const n = nextId();
  const [event] = await db
    .insert(agents)
    .values({
      name: `Test Event ${n}`,
      type: "event" as AgentType,
      visibility: "public" as VisibilityLevel,
      metadata: {},
      ...overrides,
    } as NewAgent)
    .returning();
  return event;
}

/**
 * Inserts a test place agent (e.g. a chapter location) into the database.
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param overrides - Optional field overrides.
 * @returns The inserted place agent row.
 */
export async function createTestPlace(
  db: TestDatabase,
  overrides: Partial<NewAgent> = {}
): Promise<typeof agents.$inferSelect> {
  const n = nextId();
  const [place] = await db
    .insert(agents)
    .values({
      name: `Test Place ${n}`,
      type: "place" as AgentType,
      visibility: "public" as VisibilityLevel,
      metadata: { placeType: "chapter" },
      ...overrides,
    } as NewAgent)
    .returning();
  return place;
}

// ---------------------------------------------------------------------------
// Resource fixtures
// ---------------------------------------------------------------------------

/**
 * Inserts a test document resource into the database.
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param ownerId - Agent ID that owns this resource.
 * @param overrides - Optional field overrides.
 * @returns The inserted resource row.
 */
export async function createTestResource(
  db: TestDatabase,
  ownerId: string,
  overrides: Partial<NewResource> = {}
): Promise<typeof resources.$inferSelect> {
  const n = nextId();
  const [resource] = await db
    .insert(resources)
    .values({
      name: `Test Resource ${n}`,
      type: "document" as ResourceType,
      ownerId,
      visibility: "public" as VisibilityLevel,
      metadata: {},
      tags: [],
      ...overrides,
    } as NewResource)
    .returning();
  return resource;
}

/**
 * Inserts a test post resource into the database.
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param ownerId - Agent ID that owns this post.
 * @param overrides - Optional field overrides.
 * @returns The inserted post resource row.
 */
export async function createTestPost(
  db: TestDatabase,
  ownerId: string,
  overrides: Partial<NewResource> = {}
): Promise<typeof resources.$inferSelect> {
  const n = nextId();
  const [post] = await db
    .insert(resources)
    .values({
      name: `Test Post ${n}`,
      type: "post" as ResourceType,
      ownerId,
      content: `Test post content ${n}`,
      visibility: "public" as VisibilityLevel,
      metadata: {},
      tags: [],
      ...overrides,
    } as NewResource)
    .returning();
  return post;
}

/**
 * Inserts a test marketplace listing resource into the database.
 *
 * Defaults to a product-type listing at $10.00 with "active" status.
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param ownerId - Agent ID that owns this listing.
 * @param overrides - Optional field overrides.
 * @returns The inserted listing resource row.
 */
export async function createTestListing(
  db: TestDatabase,
  ownerId: string,
  overrides: Partial<NewResource> = {}
): Promise<typeof resources.$inferSelect> {
  const n = nextId();
  const [listing] = await db
    .insert(resources)
    .values({
      name: `Test Listing ${n}`,
      type: "listing" as ResourceType,
      ownerId,
      visibility: "public" as VisibilityLevel,
      metadata: { listingType: "product", status: "active", priceCents: 1000 },
      tags: [],
      ...overrides,
    } as NewResource)
    .returning();
  return listing;
}

// ---------------------------------------------------------------------------
// Ledger fixtures
// ---------------------------------------------------------------------------

/**
 * Inserts a generic ledger entry (defaults to a "view" verb).
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param subjectId - The acting agent ID.
 * @param overrides - Optional field overrides (verb, objectId, etc.).
 * @returns The inserted ledger row.
 */
export async function createTestLedgerEntry(
  db: TestDatabase,
  subjectId: string,
  overrides: Partial<NewLedgerEntry> = {}
): Promise<typeof ledger.$inferSelect> {
  const [entry] = await db
    .insert(ledger)
    .values({
      verb: "view" as VerbType,
      subjectId,
      isActive: true,
      metadata: {},
      ...overrides,
    } as NewLedgerEntry)
    .returning();
  return entry;
}

/**
 * Creates a "belong" ledger entry representing group membership.
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param memberId - Agent ID of the member.
 * @param groupId - Agent ID of the group being joined.
 * @param role - Membership role, defaults to "member".
 * @returns The inserted membership ledger row.
 */
export async function createMembership(
  db: TestDatabase,
  memberId: string,
  groupId: string,
  role: string = "member"
): Promise<typeof ledger.$inferSelect> {
  const [entry] = await db
    .insert(ledger)
    .values({
      verb: "belong" as VerbType,
      subjectId: memberId,
      objectId: groupId,
      objectType: "agent",
      isActive: true,
      role,
      metadata: { interactionType: "membership" },
    } as NewLedgerEntry)
    .returning();
  return entry;
}

/**
 * Creates an "own" ledger entry representing ownership of an agent or resource.
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param ownerId - Agent ID of the owner.
 * @param targetId - ID of the owned entity.
 * @param targetType - Whether the target is an "agent" or "resource" (default: "resource").
 * @returns The inserted ownership ledger row.
 */
export async function createOwnership(
  db: TestDatabase,
  ownerId: string,
  targetId: string,
  targetType: "agent" | "resource" = "resource"
): Promise<typeof ledger.$inferSelect> {
  const [entry] = await db
    .insert(ledger)
    .values({
      verb: "own" as VerbType,
      subjectId: ownerId,
      objectId: targetId,
      objectType: targetType,
      isActive: true,
      metadata: {},
    } as NewLedgerEntry)
    .returning();
  return entry;
}

/**
 * Creates a "grant" ledger entry that delegates a specific action to a target.
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param grantorId - Agent ID issuing the grant.
 * @param targetId - Resource ID receiving the grant.
 * @param action - The verb being granted (e.g. "view", "edit").
 * @param overrides - Optional field overrides.
 * @returns The inserted grant ledger row.
 */
export async function createGrant(
  db: TestDatabase,
  grantorId: string,
  targetId: string,
  action: VerbType,
  overrides: Partial<NewLedgerEntry> = {}
): Promise<typeof ledger.$inferSelect> {
  const [entry] = await db
    .insert(ledger)
    .values({
      verb: "grant" as VerbType,
      subjectId: grantorId,
      objectId: targetId,
      objectType: "resource",
      isActive: true,
      metadata: { action, scope: "global" },
      ...overrides,
    } as NewLedgerEntry)
    .returning();
  return entry;
}

// ---------------------------------------------------------------------------
// Wallet fixtures
// ---------------------------------------------------------------------------

/**
 * Inserts a test wallet with a zero balance.
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param ownerId - Agent ID that owns the wallet.
 * @param overrides - Optional field overrides (balanceCents, currency, etc.).
 * @returns The inserted wallet row.
 */
export async function createTestWallet(
  db: TestDatabase,
  ownerId: string,
  overrides: Partial<NewWalletRecord> = {}
): Promise<typeof wallets.$inferSelect> {
  const [wallet] = await db
    .insert(wallets)
    .values({
      ownerId,
      type: "personal",
      balanceCents: 0,
      currency: "usd",
      metadata: {},
      ...overrides,
    } as NewWalletRecord)
    .returning();
  return wallet;
}

// ---------------------------------------------------------------------------
// Federation fixtures
// ---------------------------------------------------------------------------

/**
 * Inserts a test federation node.
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param overrides - Optional field overrides (slug, baseUrl, role, etc.).
 * @returns The inserted node row.
 */
export async function createTestNode(
  db: TestDatabase,
  overrides: Partial<NewNodeRecord> = {}
): Promise<typeof nodes.$inferSelect> {
  const n = nextId();
  const [node] = await db
    .insert(nodes)
    .values({
      slug: `test-node-${n}`,
      displayName: `Test Node ${n}`,
      role: "group",
      baseUrl: `https://test-node-${n}.example.com`,
      metadata: {},
      ...overrides,
    } as NewNodeRecord)
    .returning();
  return node;
}

/**
 * Creates a trusted peer relationship between two federation nodes.
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param localNodeId - ID of the local node.
 * @param peerNodeId - ID of the remote peer node.
 * @param overrides - Optional field overrides (trustState, etc.).
 * @returns The inserted node peer row.
 */
export async function createTestPeer(
  db: TestDatabase,
  localNodeId: string,
  peerNodeId: string,
  overrides: Partial<NewNodePeerRecord> = {}
): Promise<typeof nodePeers.$inferSelect> {
  const [peer] = await db
    .insert(nodePeers)
    .values({
      localNodeId,
      peerNodeId,
      trustState: "trusted",
      metadata: {},
      ...overrides,
    } as NewNodePeerRecord)
    .returning();
  return peer;
}

/**
 * Inserts a queued federation event originating from a given node.
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param originNodeId - ID of the node that originated the event.
 * @param overrides - Optional field overrides (entityType, eventType, payload, etc.).
 * @returns The inserted federation event row.
 */
export async function createTestFederationEvent(
  db: TestDatabase,
  originNodeId: string,
  overrides: Partial<NewFederationEventRecord> = {}
): Promise<typeof federationEvents.$inferSelect> {
  const n = nextId();
  const [event] = await db
    .insert(federationEvents)
    .values({
      originNodeId,
      entityType: "agent",
      eventType: "create",
      status: "queued",
      payload: {},
      nonce: `test-nonce-${n}-${Date.now()}`,
      ...overrides,
    } as NewFederationEventRecord)
    .returning();
  return event;
}

// ---------------------------------------------------------------------------
// Subscription fixtures
// ---------------------------------------------------------------------------

/**
 * Inserts an active Stripe subscription for a test agent.
 *
 * Defaults to a 30-day "host" tier subscription with mock Stripe IDs.
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param agentId - Agent ID the subscription belongs to.
 * @param overrides - Optional field overrides (status, membershipTier, etc.).
 * @returns The inserted subscription row.
 */
export async function createTestSubscription(
  db: TestDatabase,
  agentId: string,
  overrides: Partial<NewSubscription> = {}
): Promise<typeof subscriptions.$inferSelect> {
  const n = nextId();
  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const [sub] = await db
    .insert(subscriptions)
    .values({
      agentId,
      stripeCustomerId: `cus_test_${n}`,
      stripeSubscriptionId: `sub_test_${n}`,
      stripePriceId: `price_test_${n}`,
      status: "active",
      membershipTier: "host",
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      ...overrides,
    } as NewSubscription)
    .returning();
  return sub;
}

// ---------------------------------------------------------------------------
// Email verification token fixtures
// ---------------------------------------------------------------------------

/**
 * Inserts an email verification token for a test agent.
 *
 * Defaults to a 24-hour expiry with a unique random token string.
 *
 * @param db - Transaction-scoped Drizzle instance.
 * @param agentId - Agent ID the token is issued to.
 * @param overrides - Optional overrides for token value, type, and expiry.
 * @returns The inserted email verification token row.
 */
export async function createTestVerificationToken(
  db: TestDatabase,
  agentId: string,
  overrides: Partial<{
    token: string;
    tokenType: string;
    expiresAt: Date;
  }> = {}
): Promise<typeof emailVerificationTokens.$inferSelect> {
  const n = nextId();
  const [tokenRecord] = await db
    .insert(emailVerificationTokens)
    .values({
      agentId,
      token: overrides.token ?? `test-token-${n}-${Date.now()}`,
      tokenType: overrides.tokenType ?? "email_verification",
      expiresAt:
        overrides.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning();
  return tokenRecord;
}
