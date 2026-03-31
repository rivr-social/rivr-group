/**
 * Database seed module — Rivr Dev Data.
 *
 * Seeds basins, locales, 3 group types (basic, organization, ring), and
 * comprehensive resources/ledger entries so every tab has real data to display.
 *
 * Usage:
 *   pnpm db:seed
 *   # or from Docker:
 *   docker exec pmdl_rivr sh -c 'DB_PASS=$(cat /run/secrets/rivr_db_password | tr -d "[:space:]"); export DATABASE_URL="postgresql://rivr:${DB_PASS}@postgres:5432/rivr"; pnpm db:seed'
 *
 * Idempotent: deletes previous seed data (by known IDs) then re-inserts.
 */

import { db } from "@/db";
import { agents, resources, ledger } from "@/db/schema";
import { sql } from "drizzle-orm";

// ── Deterministic UUIDs ─────────────────────────────────────────────────────

// Basin IDs
const BASIN_SOUTH_PLATTE = "b0000000-0000-4000-8000-000000000001";
const BASIN_COLORADO_TX  = "b0000000-0000-4000-8000-000000000002";
const BASIN_SF_BAY       = "b0000000-0000-4000-8000-000000000003";

// Locale IDs
const LOCALE_BOULDER = "c0000000-0000-4000-8000-000000000001";
const LOCALE_AUSTIN  = "c0000000-0000-4000-8000-000000000002";
const LOCALE_SF      = "c0000000-0000-4000-8000-000000000003";

// Group IDs
const GROUP_BASIC = "d0000000-0000-4000-8000-000000000001";
const GROUP_ORG   = "d0000000-0000-4000-8000-000000000002";
const GROUP_RING  = "d0000000-0000-4000-8000-000000000003";

// Subgroup IDs
const SUBGROUP_DESIGN  = "d0000000-0000-4000-8000-000000000010";
const SUBGROUP_BACKEND = "d0000000-0000-4000-8000-000000000011";
const SUBGROUP_EVENTS  = "d0000000-0000-4000-8000-000000000012";

// Seed member IDs (fake users that exist only for seed data)
const SEED_USER_ALICE = "a0000000-0000-4000-8000-000000000001";
const SEED_USER_BOB   = "a0000000-0000-4000-8000-000000000002";
const SEED_USER_CAROL = "a0000000-0000-4000-8000-000000000003";
const SEED_USER_DAVE  = "a0000000-0000-4000-8000-000000000004";
const SEED_USER_EVE   = "a0000000-0000-4000-8000-000000000005";

const SEED_USERS = [SEED_USER_ALICE, SEED_USER_BOB, SEED_USER_CAROL, SEED_USER_DAVE, SEED_USER_EVE];

// Resource IDs — posts
const POST_1 = "e0000000-0000-4000-8000-000000000001";
const POST_2 = "e0000000-0000-4000-8000-000000000002";
const POST_3 = "e0000000-0000-4000-8000-000000000003";
const POST_4 = "e0000000-0000-4000-8000-000000000004";
const POST_5 = "e0000000-0000-4000-8000-000000000005";
const POST_6 = "e0000000-0000-4000-8000-000000000006";

// Resource IDs — events
const EVENT_1 = "e1000000-0000-4000-8000-000000000001";
const EVENT_2 = "e1000000-0000-4000-8000-000000000002";
const EVENT_3 = "e1000000-0000-4000-8000-000000000003";
const EVENT_4 = "e1000000-0000-4000-8000-000000000004";
const EVENT_5 = "e1000000-0000-4000-8000-000000000005";

// Resource IDs — jobs
const JOB_1 = "e2000000-0000-4000-8000-000000000001";
const JOB_2 = "e2000000-0000-4000-8000-000000000002";
const JOB_3 = "e2000000-0000-4000-8000-000000000003";

// Resource IDs — tasks
const TASK_1 = "e2100000-0000-4000-8000-000000000001";
const TASK_2 = "e2100000-0000-4000-8000-000000000002";

// Resource IDs — projects
const PROJECT_1 = "e2200000-0000-4000-8000-000000000001";

// Resource IDs — listings (marketplace)
const LISTING_1 = "e3000000-0000-4000-8000-000000000001";
const LISTING_2 = "e3000000-0000-4000-8000-000000000002";
const LISTING_3 = "e3000000-0000-4000-8000-000000000003";
const LISTING_4 = "e3000000-0000-4000-8000-000000000004";

// Resource IDs — badges
const BADGE_1 = "e4000000-0000-4000-8000-000000000001";
const BADGE_2 = "e4000000-0000-4000-8000-000000000002";
const BADGE_3 = "e4000000-0000-4000-8000-000000000003";

// Resource IDs — press
const PRESS_1 = "e5000000-0000-4000-8000-000000000001";
const PRESS_2 = "e5000000-0000-4000-8000-000000000002";

// Ledger entry IDs
const LEDGER_PREFIX = "f0000000-0000-4000-8000-";

// Old IDs from previous seed runs that need cleanup
const OLD_IDS = [
  "b0000000-0000-4000-8000-000000000004",
  "b0000000-0000-4000-8000-000000000005",
  "c0000000-0000-4000-8000-000000000004",
  "c0000000-0000-4000-8000-000000000005",
  "c0000000-0000-4000-8000-000000000006",
  "c0000000-0000-4000-8000-000000000007",
  "c0000000-0000-4000-8000-000000000008",
  "c0000000-0000-4000-8000-000000000009",
  "c0000000-0000-4000-8000-00000000000a",
  "c0000000-0000-4000-8000-00000000000b",
  "c0000000-0000-4000-8000-00000000000c",
  "c0000000-0000-4000-8000-00000000000d",
  "c0000000-0000-4000-8000-00000000000e",
  "c0000000-0000-4000-8000-00000000000f",
];

// All seed IDs for cleanup
const ALL_RESOURCE_IDS = [
  POST_1, POST_2, POST_3, POST_4, POST_5, POST_6,
  EVENT_1, EVENT_2, EVENT_3, EVENT_4, EVENT_5,
  JOB_1, JOB_2, JOB_3,
  TASK_1, TASK_2,
  PROJECT_1,
  LISTING_1, LISTING_2, LISTING_3, LISTING_4,
  BADGE_1, BADGE_2, BADGE_3,
  PRESS_1, PRESS_2,
];

const ALL_AGENT_IDS = [
  BASIN_SOUTH_PLATTE, BASIN_COLORADO_TX, BASIN_SF_BAY,
  LOCALE_BOULDER, LOCALE_AUSTIN, LOCALE_SF,
  GROUP_BASIC, GROUP_ORG, GROUP_RING,
  SUBGROUP_DESIGN, SUBGROUP_BACKEND, SUBGROUP_EVENTS,
  ...SEED_USERS,
  ...OLD_IDS,
];

// ── Helper: future date ─────────────────────────────────────────────────────

function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// ── Seed Logic ──────────────────────────────────────────────────────────────

export async function main() {
  console.log("[seed] Cleaning up old seed data...");

  // Delete in dependency order: ledger → resources → agents
  for (const id of ALL_RESOURCE_IDS) {
    await db.execute(sql`DELETE FROM ledger WHERE resource_id = ${id}`);
    await db.execute(sql`DELETE FROM resources WHERE id = ${id}`);
  }
  for (const id of ALL_AGENT_IDS) {
    await db.execute(sql`DELETE FROM ledger WHERE subject_id = ${id} OR object_id = ${id}::text`);
    await db.execute(sql`DELETE FROM resources WHERE owner_id = ${id}`);
    await db.execute(sql`DELETE FROM agents WHERE id = ${id}`);
  }
  // Clean ledger entries with our prefix
  await db.execute(sql`DELETE FROM ledger WHERE id::text LIKE 'f0000000-0000-4000-8000-%'`);

  console.log("[seed] Seeding basins and locales...");

  // ── Basins ──
  const basins = [
    { id: BASIN_SOUTH_PLATTE, name: "South Platte Basin", description: "The South Platte River watershed along Colorado's Front Range.", huc6Code: "101900" },
    { id: BASIN_COLORADO_TX, name: "Colorado River of Texas Basin", description: "The Colorado River of Texas watershed, stretching from Hill Country through Austin.", huc6Code: "120902" },
    { id: BASIN_SF_BAY, name: "San Francisco Bay Basin", description: "The San Francisco Bay watershed encompassing the Bay Area's diverse communities.", huc6Code: "180500" },
  ];
  for (const basin of basins) {
    await db.insert(agents).values({
      id: basin.id, name: basin.name, type: "organization", description: basin.description,
      visibility: "public", metadata: { placeType: "basin", huc6Code: basin.huc6Code }, depth: 0,
    }).onConflictDoNothing({ target: agents.id });
    console.log(`  [basin] ${basin.name}`);
  }

  // ── Locales ──
  const locales = [
    { id: LOCALE_BOULDER, name: "Boulder", description: "Where the Rockies meet the plains — Rivr's first activated Commons.", location: "Boulder, CO", basinId: BASIN_SOUTH_PLATTE, isCommons: true, slug: "boulder" },
    { id: LOCALE_AUSTIN, name: "Austin", description: "The Live Music Capital — building urban resilience along the Colorado River.", location: "Austin, TX", basinId: BASIN_COLORADO_TX, isCommons: false, slug: "austin" },
    { id: LOCALE_SF, name: "San Francisco", description: "Innovation hub on the Bay — exploring cooperative platforms.", location: "San Francisco, CA", basinId: BASIN_SF_BAY, isCommons: false, slug: "san-francisco" },
  ];
  for (const locale of locales) {
    await db.insert(agents).values({
      id: locale.id, name: locale.name, type: "organization", description: locale.description,
      visibility: "public", parentId: locale.basinId, pathIds: [locale.basinId],
      metadata: { placeType: "chapter", location: locale.location, basinId: locale.basinId, isCommons: locale.isCommons, slug: locale.slug }, depth: 1,
    }).onConflictDoNothing({ target: agents.id });
    console.log(`  [locale] ${locale.name}${locale.isCommons ? " (Commons)" : ""}`);
  }

  // ── Seed Users ──
  console.log("[seed] Seeding dev users...");
  const seedUsers = [
    { id: SEED_USER_ALICE, name: "Alice Rivera", email: "alice@seed.rivr.local", image: "/placeholder-user.jpg", metadata: { bio: "Community organizer and permaculture designer in Boulder.", username: "alice-rivera" } },
    { id: SEED_USER_BOB, name: "Bob Chen", email: "bob@seed.rivr.local", image: "/placeholder-user.jpg", metadata: { bio: "Full-stack developer passionate about cooperative tech.", username: "bob-chen" } },
    { id: SEED_USER_CAROL, name: "Carol Nakamura", email: "carol@seed.rivr.local", image: "/placeholder-user.jpg", metadata: { bio: "Environmental scientist studying watershed health.", username: "carol-nakamura" } },
    { id: SEED_USER_DAVE, name: "Dave Okonkwo", email: "dave@seed.rivr.local", image: "/placeholder-user.jpg", metadata: { bio: "Small business owner and local food systems advocate.", username: "dave-okonkwo" } },
    { id: SEED_USER_EVE, name: "Eve Marchetti", email: "eve@seed.rivr.local", image: "/placeholder-user.jpg", metadata: { bio: "Graphic designer and community arts facilitator.", username: "eve-marchetti" } },
  ];
  for (const user of seedUsers) {
    await db.insert(agents).values({
      id: user.id, name: user.name, type: "person", email: user.email,
      image: user.image, visibility: "public", metadata: user.metadata, depth: 0,
      emailVerified: new Date(),
    }).onConflictDoNothing({ target: agents.id });
    console.log(`  [user] ${user.name}`);
  }

  // ── Group 1: Basic Group (community) ──
  console.log("[seed] Seeding Group 1: Boulder Trail Runners (basic)...");
  await db.insert(agents).values({
    id: GROUP_BASIC,
    name: "Boulder Trail Runners",
    type: "community",
    description: "A casual community for trail running enthusiasts in Boulder County. We organize weekly group runs, share trail conditions, and support each other's training goals. All paces welcome!",
    visibility: "public",
    metadata: {
      groupType: "basic",
      creatorId: SEED_USER_ALICE,
      adminIds: [SEED_USER_ALICE, SEED_USER_BOB],
      tags: ["running", "trails", "fitness", "outdoors", "boulder"],
      location: "Boulder, CO",
      contactInfo: {
        email: "runners@boulder.rivr.local",
        website: "https://bouldertrailrunners.rivr.local",
      },
    },
    depth: 0,
  }).onConflictDoNothing({ target: agents.id });

  // ── Group 2: Organization ──
  console.log("[seed] Seeding Group 2: Front Range Food Co-op (organization)...");
  await db.insert(agents).values({
    id: GROUP_ORG,
    name: "Front Range Food Co-op",
    type: "organization",
    description: "A member-owned cooperative connecting local farmers, ranchers, and food producers with Front Range communities. We operate a weekly farmers market, run a community-supported agriculture (CSA) program, and advocate for food sovereignty. Members share in governance and profits.",
    visibility: "public",
    metadata: {
      groupType: "organization",
      creatorId: SEED_USER_DAVE,
      adminIds: [SEED_USER_DAVE, SEED_USER_CAROL],
      tags: ["food", "cooperative", "local", "farming", "sustainability", "CSA"],
      location: "Boulder & Denver, CO",
      contactInfo: {
        email: "hello@frontrangefood.rivr.local",
        website: "https://frontrangefood.rivr.local",
        phone: "(303) 555-0142",
      },
      // Governance items stored in group metadata
      proposals: [
        {
          id: "prop-1",
          type: "proposal",
          title: "Expand CSA delivery to Longmont",
          description: "Proposal to extend our CSA delivery radius to include Longmont and surrounding areas. This would require one additional delivery vehicle and driver.",
          status: "Active",
          votesFor: 18,
          votesAgainst: 3,
          votesAbstain: 2,
          quorum: 15,
          threshold: 66,
          creatorName: "Dave Okonkwo",
          createdAt: daysAgo(5),
          deadline: daysFromNow(10),
          comments: 7,
        },
        {
          id: "prop-2",
          type: "proposal",
          title: "Adopt sliding-scale membership dues",
          description: "Replace fixed $50/month membership with a $25-$75 sliding scale so lower-income families can participate. Revenue-neutral based on current member income distribution.",
          status: "Passed",
          votesFor: 31,
          votesAgainst: 4,
          votesAbstain: 1,
          quorum: 20,
          threshold: 66,
          creatorName: "Carol Nakamura",
          createdAt: daysAgo(30),
          deadline: daysAgo(15),
          comments: 12,
        },
      ],
      polls: [
        {
          id: "poll-1",
          type: "poll",
          question: "What day works best for the summer farmers market?",
          options: [
            { id: "opt-sat", label: "Saturday morning", votes: 24 },
            { id: "opt-sun", label: "Sunday morning", votes: 11 },
            { id: "opt-wed", label: "Wednesday evening", votes: 8 },
          ],
          totalVotes: 43,
          creatorName: "Dave Okonkwo",
          createdAt: daysAgo(3),
          deadline: daysFromNow(4),
        },
      ],
      issues: [
        {
          id: "issue-1",
          type: "issue",
          title: "Refrigerated truck needs maintenance",
          description: "The refrigerated delivery truck is making a grinding noise on startup. Need to schedule inspection before next CSA delivery cycle.",
          status: "open",
          creatorName: "Bob Chen",
          createdAt: daysAgo(2),
          tags: ["logistics", "urgent"],
          votesUp: 5,
          votesDown: 0,
          comments: 3,
        },
        {
          id: "issue-2",
          type: "issue",
          title: "Onboarding process too confusing for new members",
          description: "Several new members have reported confusion about how to sign up for CSA shares vs market-only membership. We should simplify the options.",
          status: "open",
          creatorName: "Eve Marchetti",
          createdAt: daysAgo(7),
          tags: ["UX", "membership"],
          votesUp: 8,
          votesDown: 1,
          comments: 6,
        },
      ],
      // Membership plans
      membershipPlans: [
        {
          id: "plan-market",
          name: "Market Member",
          description: "Access to weekly farmers market and member pricing",
          active: true,
          isDefault: true,
          amountMonthlyCents: 2500,
          amountYearlyCents: 25000,
          perks: ["Market access", "Member pricing", "Newsletter"],
        },
        {
          id: "plan-csa",
          name: "CSA Share",
          description: "Weekly box of seasonal produce delivered to your door, plus all Market Member benefits",
          active: true,
          isDefault: false,
          amountMonthlyCents: 7500,
          amountYearlyCents: 75000,
          perks: ["Weekly produce box", "Market access", "Member pricing", "Voting rights", "Profit share"],
        },
      ],
    },
    depth: 0,
  }).onConflictDoNothing({ target: agents.id });

  // ── Group 3: Ring ──
  console.log("[seed] Seeding Group 3: Watershed Stewards Ring (ring)...");
  await db.insert(agents).values({
    id: GROUP_RING,
    name: "Watershed Stewards Ring",
    type: "ring",
    description: "A cross-organizational ring connecting water quality monitors, riparian restoration crews, and policy advocates across the South Platte Basin. Ring members share data, coordinate volunteer days, and jointly fund watershed health projects through our shared treasury.",
    visibility: "public",
    metadata: {
      groupType: "ring",
      creatorId: SEED_USER_CAROL,
      adminIds: [SEED_USER_CAROL, SEED_USER_ALICE],
      tags: ["water", "environment", "restoration", "monitoring", "advocacy", "science"],
      location: "South Platte Basin, CO",
      contactInfo: {
        email: "stewards@watershed.rivr.local",
        website: "https://watershedstewards.rivr.local",
      },
      proposals: [
        {
          id: "prop-ring-1",
          type: "proposal",
          title: "Fund Boulder Creek riparian buffer planting",
          description: "Allocate $3,200 from the ring treasury to purchase native willow and cottonwood saplings for the Boulder Creek riparian buffer restoration project at 75th St.",
          status: "Active",
          votesFor: 9,
          votesAgainst: 1,
          votesAbstain: 0,
          quorum: 8,
          threshold: 75,
          creatorName: "Carol Nakamura",
          createdAt: daysAgo(4),
          deadline: daysFromNow(7),
          comments: 4,
        },
      ],
      polls: [
        {
          id: "poll-ring-1",
          type: "poll",
          question: "Priority site for next water quality monitoring station?",
          options: [
            { id: "opt-coal", label: "Coal Creek confluence", votes: 7 },
            { id: "opt-south", label: "South Boulder Creek at Baseline", votes: 5 },
            { id: "opt-dry", label: "Dry Creek near Erie", votes: 3 },
          ],
          totalVotes: 15,
          creatorName: "Alice Rivera",
          createdAt: daysAgo(6),
          deadline: daysFromNow(8),
        },
      ],
      issues: [
        {
          id: "issue-ring-1",
          type: "issue",
          title: "Sensor station #4 offline since Tuesday",
          description: "The turbidity and dissolved oxygen sensor at station #4 (Coal Creek) stopped transmitting. Battery or cellular modem may need replacement.",
          status: "open",
          creatorName: "Bob Chen",
          createdAt: daysAgo(3),
          tags: ["sensors", "maintenance"],
          votesUp: 4,
          votesDown: 0,
          comments: 2,
        },
      ],
      membershipPlans: [
        {
          id: "plan-steward",
          name: "Steward",
          description: "Full ring membership with voting, treasury access, and data sharing",
          active: true,
          isDefault: true,
          amountMonthlyCents: 1000,
          amountYearlyCents: 10000,
          perks: ["Voting rights", "Treasury proposals", "Shared data", "Volunteer coordination"],
        },
      ],
    },
    depth: 0,
  }).onConflictDoNothing({ target: agents.id });

  // ── Subgroups (children of the org) ──
  console.log("[seed] Seeding subgroups...");
  const subgroups = [
    { id: SUBGROUP_DESIGN, name: "Design Team", parent: GROUP_ORG, description: "Branding, packaging, and signage for the co-op." },
    { id: SUBGROUP_BACKEND, name: "Tech & Logistics", parent: GROUP_ORG, description: "Website, ordering system, and delivery route optimization." },
    { id: SUBGROUP_EVENTS, name: "Events Committee", parent: GROUP_ORG, description: "Planning markets, harvest dinners, and community workshops." },
  ];
  for (const sg of subgroups) {
    await db.insert(agents).values({
      id: sg.id, name: sg.name, type: "organization", description: sg.description,
      parentId: sg.parent, pathIds: [sg.parent], visibility: "public",
      metadata: { groupType: "basic", creatorId: SEED_USER_DAVE }, depth: 1,
    }).onConflictDoNothing({ target: agents.id });
    console.log(`  [subgroup] ${sg.name}`);
  }

  // ── Membership ledger entries (join verb) ──
  console.log("[seed] Seeding memberships...");
  const memberships: Array<{ userId: string; groupId: string; role?: string }> = [
    // Basic group
    { userId: SEED_USER_ALICE, groupId: GROUP_BASIC, role: "admin" },
    { userId: SEED_USER_BOB, groupId: GROUP_BASIC, role: "admin" },
    { userId: SEED_USER_CAROL, groupId: GROUP_BASIC },
    { userId: SEED_USER_EVE, groupId: GROUP_BASIC },
    // Organization
    { userId: SEED_USER_DAVE, groupId: GROUP_ORG, role: "admin" },
    { userId: SEED_USER_CAROL, groupId: GROUP_ORG, role: "admin" },
    { userId: SEED_USER_ALICE, groupId: GROUP_ORG },
    { userId: SEED_USER_BOB, groupId: GROUP_ORG },
    { userId: SEED_USER_EVE, groupId: GROUP_ORG },
    // Ring
    { userId: SEED_USER_CAROL, groupId: GROUP_RING, role: "admin" },
    { userId: SEED_USER_ALICE, groupId: GROUP_RING, role: "admin" },
    { userId: SEED_USER_BOB, groupId: GROUP_RING },
    { userId: SEED_USER_DAVE, groupId: GROUP_RING },
  ];
  let ledgerIdx = 0;
  for (const m of memberships) {
    ledgerIdx++;
    await db.insert(ledger).values({
      id: `${LEDGER_PREFIX}${String(ledgerIdx).padStart(12, "0")}`,
      verb: "join",
      subjectId: m.userId,
      objectId: m.groupId,
      objectType: "agent",
      isActive: true,
      role: m.role ?? "member",
      timestamp: new Date(Date.now() - ledgerIdx * 86400000),
    }).onConflictDoNothing({ target: ledger.id });
  }

  // ── Posts ──
  console.log("[seed] Seeding posts...");
  const posts = [
    // Basic group posts
    { id: POST_1, name: "Morning run at Chautauqua", ownerId: SEED_USER_ALICE, groupId: GROUP_BASIC,
      content: "Beautiful sunrise run this morning on the Mesa Trail. About 8 miles with 1,500ft elevation gain. The wildflowers are just starting to bloom at the higher elevations! Anyone want to join me Wednesday at 6am?",
      metadata: { entityType: "post", postType: "text", groupDbId: GROUP_BASIC } },
    { id: POST_2, name: "Trail condition update", ownerId: SEED_USER_BOB, groupId: GROUP_BASIC,
      content: "Heads up: the Green Bear trail has some muddy sections near the creek crossing after yesterday's rain. Waterproof shoes recommended. Everything else on the south mesa is dry and fast.",
      metadata: { entityType: "post", postType: "text", groupDbId: GROUP_BASIC } },
    // Org posts
    { id: POST_3, name: "CSA Week 12 Box Preview", ownerId: SEED_USER_DAVE, groupId: GROUP_ORG,
      content: "This week's CSA box is packed: heirloom tomatoes, sweet corn, basil, summer squash, peaches, and a surprise from Meadow Creek Farm! Pickup is Thursday 4-7pm at the barn.",
      metadata: { entityType: "post", postType: "text", groupDbId: GROUP_ORG } },
    { id: POST_4, name: "New vendor announcement", ownerId: SEED_USER_CAROL, groupId: GROUP_ORG,
      content: "Excited to welcome Rocky Mountain Mushrooms to our Saturday market! They grow shiitake, oyster, and lion's mane in Louisville. Stop by and say hello this weekend.",
      metadata: { entityType: "post", postType: "text", groupDbId: GROUP_ORG } },
    // Ring posts
    { id: POST_5, name: "Water quality data for July", ownerId: SEED_USER_CAROL, groupId: GROUP_RING,
      content: "July monitoring data is up on the shared dashboard. Key findings: dissolved oxygen levels at Station #2 dropped below 6 mg/L during the heat wave. E. coli counts within safe limits at all stations. Full report attached.",
      metadata: { entityType: "post", postType: "text", groupDbId: GROUP_RING } },
    { id: POST_6, name: "Volunteer day success!", ownerId: SEED_USER_ALICE, groupId: GROUP_RING,
      content: "22 volunteers came out for the Coal Creek cleanup day! We removed 340 lbs of trash, planted 50 willow stakes along the eroded bank, and installed 2 new sediment traps. Photos coming soon. Thank you all!",
      metadata: { entityType: "post", postType: "text", groupDbId: GROUP_RING } },
  ];
  for (const post of posts) {
    await db.insert(resources).values({
      id: post.id, name: post.name, type: "post", content: post.content,
      ownerId: post.ownerId, visibility: "public", metadata: post.metadata,
      createdAt: new Date(Date.now() - Math.random() * 7 * 86400000),
    }).onConflictDoNothing({ target: resources.id });
  }

  // ── Events ──
  console.log("[seed] Seeding events...");
  const events = [
    // Basic group
    { id: EVENT_1, name: "Saturday Morning Group Run", ownerId: SEED_USER_ALICE, groupId: GROUP_BASIC,
      description: "Easy-pace group run on the Boulder Creek Path. 5-7 miles, all paces welcome. Meet at the trailhead parking lot.",
      metadata: { resourceKind: "event", location: "Boulder Creek Path Trailhead", date: daysFromNow(3), startDate: daysFromNow(3), endDate: daysFromNow(3), price: 0, groupDbId: GROUP_BASIC } },
    { id: EVENT_2, name: "Trail Running 101 Workshop", ownerId: SEED_USER_BOB, groupId: GROUP_BASIC,
      description: "Learn trail running basics: gear selection, pacing on hills, nutrition, and safety. Perfect for road runners wanting to transition to trails.",
      metadata: { resourceKind: "event", location: "Chautauqua Park", date: daysFromNow(10), startDate: daysFromNow(10), endDate: daysFromNow(10), price: 0, groupDbId: GROUP_BASIC } },
    // Org events
    { id: EVENT_3, name: "Summer Farmers Market", ownerId: SEED_USER_DAVE, groupId: GROUP_ORG,
      description: "Weekly farmers market featuring 20+ local vendors. Live music by the Front Range Bluegrass Collective. Kids activities, cooking demos, and free kombucha samples.",
      metadata: { resourceKind: "event", location: "Pearl Street Mall, Boulder", date: daysFromNow(5), startDate: daysFromNow(5), endDate: daysFromNow(5), price: 0, groupDbId: GROUP_ORG } },
    { id: EVENT_4, name: "Harvest Dinner: Farm to Table", ownerId: SEED_USER_CAROL, groupId: GROUP_ORG,
      description: "An intimate farm-to-table dinner at Meadow Creek Farm. Chef Maria Torres prepares a 5-course meal entirely from co-op member farms. Limited to 40 seats.",
      metadata: { resourceKind: "event", location: "Meadow Creek Farm, Longmont", date: daysFromNow(21), startDate: daysFromNow(21), endDate: daysFromNow(21), price: 45, groupDbId: GROUP_ORG } },
    // Ring events
    { id: EVENT_5, name: "Water Quality Monitoring Training", ownerId: SEED_USER_CAROL, groupId: GROUP_RING,
      description: "Hands-on training for new volunteer monitors. Learn to collect samples, calibrate instruments, and upload data to our shared platform. Certification provided.",
      metadata: { resourceKind: "event", location: "South Boulder Creek at Baseline Rd", date: daysFromNow(14), startDate: daysFromNow(14), endDate: daysFromNow(14), price: 0, groupDbId: GROUP_RING } },
  ];
  for (const event of events) {
    await db.insert(resources).values({
      id: event.id, name: event.name, type: "event", description: event.description,
      ownerId: event.ownerId, visibility: "public", metadata: event.metadata,
      createdAt: new Date(Date.now() - Math.random() * 5 * 86400000),
    }).onConflictDoNothing({ target: resources.id });
  }

  // ── Jobs (org + ring only) ──
  console.log("[seed] Seeding jobs...");
  const jobs = [
    { id: JOB_1, name: "Market Operations Manager", ownerId: SEED_USER_DAVE, groupId: GROUP_ORG,
      description: "Part-time position managing Saturday market setup, vendor coordination, and customer service. 15-20 hours/week during market season (May-October).",
      metadata: { resourceKind: "job", jobType: "part-time", compensation: "$22/hr", location: "Boulder, CO", groupDbId: GROUP_ORG, status: "open" } },
    { id: JOB_2, name: "CSA Delivery Driver", ownerId: SEED_USER_DAVE, groupId: GROUP_ORG,
      description: "Thursday delivery route covering Boulder, Louisville, and Lafayette. Must have valid CO driver's license and be comfortable with a refrigerated van.",
      metadata: { resourceKind: "job", jobType: "part-time", compensation: "$18/hr + tips", location: "Boulder County, CO", groupDbId: GROUP_ORG, status: "open" } },
    { id: JOB_3, name: "Volunteer Monitor Coordinator", ownerId: SEED_USER_CAROL, groupId: GROUP_RING,
      description: "Coordinate 15+ volunteer water quality monitors across 8 stations. Schedule shifts, maintain equipment inventory, and ensure data quality. Stipend position.",
      metadata: { resourceKind: "job", jobType: "stipend", compensation: "$500/month stipend", location: "Remote + fieldwork", groupDbId: GROUP_RING, status: "open" } },
  ];
  for (const job of jobs) {
    await db.insert(resources).values({
      id: job.id, name: job.name, type: "job", description: job.description,
      ownerId: job.ownerId, visibility: "public", metadata: job.metadata,
    }).onConflictDoNothing({ target: resources.id });
  }

  // ── Tasks ──
  console.log("[seed] Seeding tasks...");
  const tasks = [
    { id: TASK_1, name: "Set up online ordering form for CSA", ownerId: SEED_USER_BOB, groupId: GROUP_ORG,
      description: "Build an online form for new CSA members to choose their box size and delivery preferences.",
      metadata: { resourceKind: "task", projectId: PROJECT_1, status: "in-progress", assignee: SEED_USER_BOB, groupDbId: GROUP_ORG } },
    { id: TASK_2, name: "Design CSA box insert card", ownerId: SEED_USER_EVE, groupId: GROUP_ORG,
      description: "Weekly card with recipe ideas and farmer bios to include in each CSA delivery box.",
      metadata: { resourceKind: "task", projectId: PROJECT_1, status: "completed", assignee: SEED_USER_EVE, groupDbId: GROUP_ORG } },
  ];
  for (const task of tasks) {
    await db.insert(resources).values({
      id: task.id, name: task.name, type: "task", description: task.description,
      ownerId: task.ownerId, visibility: "members", metadata: task.metadata,
    }).onConflictDoNothing({ target: resources.id });
  }

  // ── Projects ──
  console.log("[seed] Seeding projects...");
  await db.insert(resources).values({
    id: PROJECT_1,
    name: "CSA Program Expansion",
    type: "project",
    description: "Expand the CSA program from 30 to 60 members with online ordering, new delivery routes, and marketing.",
    ownerId: SEED_USER_DAVE,
    visibility: "members",
    metadata: {
      resourceKind: "project",
      groupDbId: GROUP_ORG,
      status: "active",
      jobs: [{ id: JOB_1, title: "Market Operations Manager" }],
    },
  }).onConflictDoNothing({ target: resources.id });

  // ── Marketplace Listings ──
  console.log("[seed] Seeding marketplace listings...");
  const listings = [
    { id: LISTING_1, name: "Heirloom Tomato Seedlings (6-pack)", ownerId: SEED_USER_ALICE, groupId: GROUP_ORG,
      description: "Six varieties of heirloom tomato seedlings, grown from saved seed. Includes Brandywine, Cherokee Purple, Green Zebra, San Marzano, Mortgage Lifter, and Black Krim.",
      metadata: { listingType: "product", price: 12, currency: "USD", category: "plants", groupDbId: GROUP_ORG } },
    { id: LISTING_2, name: "Permaculture Design Consultation", ownerId: SEED_USER_ALICE, groupId: GROUP_ORG,
      description: "2-hour on-site consultation for your yard or garden. Includes water harvesting assessment, food forest layout, and a written plan with plant list.",
      metadata: { listingType: "service", price: 120, currency: "USD", category: "consulting", groupDbId: GROUP_ORG } },
    { id: LISTING_3, name: "Fresh Shiitake Mushrooms (1 lb)", ownerId: SEED_USER_DAVE, groupId: GROUP_ORG,
      description: "Locally grown shiitake mushrooms from Rocky Mountain Mushrooms. Harvested same-day for peak freshness.",
      metadata: { listingType: "product", price: 14, currency: "USD", category: "produce", groupDbId: GROUP_ORG } },
    { id: LISTING_4, name: "Water Quality Testing Kit", ownerId: SEED_USER_CAROL, groupId: GROUP_RING,
      description: "Complete citizen science water testing kit: pH strips, dissolved oxygen meter, turbidity tube, sample bottles, and field guide. Calibrated and ready to use.",
      metadata: { listingType: "product", price: 65, currency: "USD", category: "equipment", groupDbId: GROUP_RING } },
  ];
  for (const listing of listings) {
    await db.insert(resources).values({
      id: listing.id, name: listing.name, type: "resource",
      description: listing.description, ownerId: listing.ownerId,
      visibility: "public", metadata: listing.metadata,
    }).onConflictDoNothing({ target: resources.id });
  }

  // ── Badges ──
  console.log("[seed] Seeding badges...");
  const badges = [
    { id: BADGE_1, name: "Trail Blazer", ownerId: GROUP_ORG, groupId: GROUP_ORG,
      description: "Awarded for completing 10 volunteer shifts.",
      metadata: { resourceKind: "badge", icon: "flame", color: "orange", criteria: "Complete 10 volunteer shifts", groupDbId: GROUP_ORG } },
    { id: BADGE_2, name: "Watershed Guardian", ownerId: GROUP_RING, groupId: GROUP_RING,
      description: "Certified volunteer water quality monitor.",
      metadata: { resourceKind: "badge", icon: "droplets", color: "blue", criteria: "Complete monitoring training and 5 sampling sessions", groupDbId: GROUP_RING } },
    { id: BADGE_3, name: "Harvest Helper", ownerId: GROUP_ORG, groupId: GROUP_ORG,
      description: "Helped at 3 or more market days.",
      metadata: { resourceKind: "badge", icon: "wheat", color: "amber", criteria: "Volunteer at 3+ Saturday markets", groupDbId: GROUP_ORG } },
  ];
  for (const badge of badges) {
    await db.insert(resources).values({
      id: badge.id, name: badge.name, type: "badge",
      description: badge.description, ownerId: badge.ownerId,
      visibility: "public", metadata: badge.metadata,
    }).onConflictDoNothing({ target: resources.id });
  }

  // Badge awards via ledger
  const badgeAwards = [
    { userId: SEED_USER_ALICE, badgeId: BADGE_1 },
    { userId: SEED_USER_ALICE, badgeId: BADGE_3 },
    { userId: SEED_USER_CAROL, badgeId: BADGE_2 },
    { userId: SEED_USER_BOB, badgeId: BADGE_2 },
    { userId: SEED_USER_EVE, badgeId: BADGE_3 },
  ];
  for (const award of badgeAwards) {
    ledgerIdx++;
    await db.insert(ledger).values({
      id: `${LEDGER_PREFIX}${String(ledgerIdx).padStart(12, "0")}`,
      verb: "earn",
      subjectId: award.userId,
      objectId: award.badgeId,
      objectType: "resource",
      resourceId: award.badgeId,
      isActive: true,
      timestamp: new Date(Date.now() - Math.random() * 30 * 86400000),
    }).onConflictDoNothing({ target: ledger.id });
  }

  // ── Press / News (document resources with category: press) ──
  console.log("[seed] Seeding press articles...");
  const pressArticles = [
    { id: PRESS_1, name: "Boulder Co-op Leads Local Food Revolution", ownerId: GROUP_ORG, groupId: GROUP_ORG,
      content: "The Front Range Food Co-op has grown from 12 founding members to over 200 in just two years, proving that community-owned food systems can thrive in Colorado's competitive grocery landscape. The co-op sources from 30+ local farms within a 50-mile radius.",
      metadata: { resourceSubtype: "document", category: "press", source: "Boulder Daily Camera", publishedDate: daysAgo(45), groupDbId: GROUP_ORG } },
    { id: PRESS_2, name: "Citizen Scientists Monitor South Platte Watershed Health", ownerId: GROUP_RING, groupId: GROUP_RING,
      content: "A network of trained volunteer monitors is providing unprecedented real-time data on water quality across the South Platte Basin. The Watershed Stewards Ring, a cooperative of environmental organizations, has deployed 8 monitoring stations and trained 15 citizen scientists.",
      metadata: { resourceSubtype: "document", category: "press", source: "Colorado Sun", publishedDate: daysAgo(20), groupDbId: GROUP_RING } },
  ];
  for (const article of pressArticles) {
    await db.insert(resources).values({
      id: article.id, name: article.name, type: "resource",
      content: article.content, ownerId: article.ownerId,
      visibility: "public", metadata: article.metadata,
    }).onConflictDoNothing({ target: resources.id });
  }

  // ── Activity ledger entries (for stake/treasury/publish tabs) ──
  console.log("[seed] Seeding activity entries...");
  const activities = [
    // Fund activities (stake tab)
    { verb: "fund" as const, subjectId: SEED_USER_DAVE, objectId: GROUP_ORG, metadata: { amount: 500, note: "Initial treasury contribution" } },
    { verb: "fund" as const, subjectId: SEED_USER_CAROL, objectId: GROUP_ORG, metadata: { amount: 250, note: "Q3 dues" } },
    { verb: "fund" as const, subjectId: SEED_USER_ALICE, objectId: GROUP_RING, metadata: { amount: 100, note: "Restoration fund contribution" } },
    { verb: "fund" as const, subjectId: SEED_USER_BOB, objectId: GROUP_RING, metadata: { amount: 200, note: "Sensor equipment fund" } },
    // Transfer activities (treasury tab)
    { verb: "transfer" as const, subjectId: SEED_USER_DAVE, objectId: GROUP_ORG, metadata: { amount: 150, to: "vendor", note: "Market tent rental" } },
    { verb: "transfer" as const, subjectId: SEED_USER_CAROL, objectId: GROUP_RING, metadata: { amount: 85, to: "supplier", note: "Replacement DO sensor" } },
    // Create/publish activities
    { verb: "create" as const, subjectId: SEED_USER_DAVE, objectId: POST_3, metadata: { type: "post" } },
    { verb: "create" as const, subjectId: SEED_USER_CAROL, objectId: POST_5, metadata: { type: "post" } },
    { verb: "create" as const, subjectId: SEED_USER_ALICE, objectId: EVENT_1, metadata: { type: "event" } },
    { verb: "publish" as const, subjectId: SEED_USER_DAVE, objectId: PRESS_1, metadata: { type: "press" } },
  ];
  for (const act of activities) {
    ledgerIdx++;
    await db.insert(ledger).values({
      id: `${LEDGER_PREFIX}${String(ledgerIdx).padStart(12, "0")}`,
      verb: act.verb,
      subjectId: act.subjectId,
      objectId: act.objectId,
      objectType: "agent",
      isActive: true,
      metadata: act.metadata,
      timestamp: new Date(Date.now() - Math.random() * 14 * 86400000),
    }).onConflictDoNothing({ target: ledger.id });
  }

  console.log(`[seed] Done.`);
  console.log(`  3 basins, 3 locales`);
  console.log(`  5 seed users`);
  console.log(`  3 groups: Boulder Trail Runners (basic), Front Range Food Co-op (org), Watershed Stewards Ring (ring)`);
  console.log(`  3 subgroups under the org`);
  console.log(`  ${posts.length} posts, ${events.length} events, ${jobs.length} jobs, ${tasks.length} tasks, 1 project`);
  console.log(`  ${listings.length} marketplace listings, ${badges.length} badges, ${pressArticles.length} press articles`);
  console.log(`  ${memberships.length} memberships, ${badgeAwards.length} badge awards, ${activities.length} activity entries`);
}

main().catch(console.error);
