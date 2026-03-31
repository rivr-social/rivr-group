# Database Schema

This directory contains the database schema, migrations, and connection management for the RIVR application.

## Overview

The database uses PostgreSQL with the following extensions:
- **PostGIS**: Geospatial data support (location-based queries)
- **pgvector**: Vector embeddings for semantic search

## Schema Structure

### Tables

#### `agents`
Represents people and governance containers (regions/basins/locales/groups). Supports:
- Hierarchical relationships (parent-child with path tracking)
- Spatial data (PostGIS geometry)
- Vector embeddings for semantic search
- Soft deletes

**Key Fields:**
- `id`: UUID primary key
- `name`: Agent name
- `type`: Enum (person, organization, project/event/place legacy, system, etc.)
- `parentId`: Reference to parent agent (for hierarchy)
- `pathIds`: Array of ancestor IDs for efficient tree queries
- `location`: PostGIS Point geometry (SRID 4326)
- `embedding`: 384-dimension vector for semantic search

#### `resources`
Stores projects, events, places/venues, documents, files, and other resources. Supports:
- Multiple storage providers (MinIO, S3)
- Vector embeddings for semantic search
- Optional spatial references
- Tags and metadata
- Access control (public/private)

**Key Fields:**
- `id`: UUID primary key
- `name`: Resource name
- `type`: Enum (document, image, video, audio, link, note, file, dataset, project, event, ...)
- `ownerId`: Reference to owning agent
- `storageKey`: Object storage key
- `embedding`: 384-dimension vector for semantic search
- `location`: Optional PostGIS Point geometry

#### `ledger`
Immutable audit log of all actions and transactions. Records:
- Who did what to which resource
- Complete transaction metadata
- Session and context information

**Key Fields:**
- `id`: UUID primary key
- `verb`: Enum (create, update, delete, transfer, share, view, clone, merge, split)
- `subjectId`: Agent who performed the action
- `objectId`: Target of the action
- `resourceId`: Optional resource reference
- `timestamp`: Immutable action timestamp

## Indices

### Full-Text Search
- `agents.name`: B-tree index for name lookups
- `resources.name`: B-tree index for name lookups
- `resources.tags`: GIN index for tag searches

### Spatial Queries
- `agents.location`: GIST index for spatial operations
- `resources.location`: GIST index for spatial operations

### Vector Similarity
- `agents.embedding`: HNSW index for cosine similarity
- `resources.embedding`: HNSW index for cosine similarity

### Hierarchical Queries
- `agents.parentId`: B-tree index for parent lookups
- `agents.pathIds`: GIN index for ancestor queries

### Performance
- Composite indices on common query patterns
- Timestamp indices for time-based queries
- Soft delete indices for filtering

## Usage

### Connection

```typescript
import { db } from '@/db';

// The db instance is pre-configured with schema and connection pooling
const agents = await db.query.agents.findMany();
```

### Health Check

```typescript
import { healthCheck } from '@/db';

const health = await healthCheck();
console.log(health.status); // 'healthy' | 'unhealthy'
console.log(health.extensions); // { postgis: true, pgvector: true }
```

### Vector Similarity Search

```typescript
import { db, agents } from '@/db';
import { sql } from 'drizzle-orm';

// Find similar agents by embedding
const similar = await db
  .select()
  .from(agents)
  .orderBy(sql`embedding <=> ${targetEmbedding}`)
  .limit(10);
```

### Spatial Queries

```typescript
import { db, agents } from '@/db';
import { sql } from 'drizzle-orm';

// Find agents within radius (meters)
const nearby = await db
  .select()
  .from(agents)
  .where(
    sql`ST_DWithin(
      location::geography,
      ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography,
      ${radiusMeters}
    )`
  );
```

### Hierarchical Queries

```typescript
import { db, agents } from '@/db';
import { sql } from 'drizzle-orm';

// Find all descendants of an agent
const descendants = await db
  .select()
  .from(agents)
  .where(sql`${agentId} = ANY(path_ids)`);

// Find all ancestors of an agent
const agent = await db.query.agents.findFirst({
  where: (agents, { eq }) => eq(agents.id, agentId),
});
const ancestorIds = agent?.pathIds || [];
const ancestors = await db
  .select()
  .from(agents)
  .where(sql`id = ANY(${ancestorIds})`);
```

## Migrations

### Generate Migration

```bash
npm run db:generate
```

### Run Migrations

```bash
npm run db:migrate
```

### Initialize Extensions

The `0000_init_extensions.sql` migration must be run first to enable PostGIS and pgvector.

## Seeding

### Seed Database with Mock Data

The seed script populates the database with comprehensive demo data from all mock data files:

```bash
npm run db:seed
```

**What gets seeded:**

**Agents:**
- Users (person agents) - All mock users from the demo app
- Chapters (organization agents) - Boulder, SF, NYC, etc.
- Basins (organization agents) - River basins for bioregional governance
- Groups (organization agents) - Climate Action Coalition, etc.
- Rings (organization agents) - Boulder Mutual Aid Network, etc.
- Families (organization agents) - Northside Neighbors, Garden Circle, etc.

**Resources:**
- Projects - Community Garden Revitalization, etc.
- Events - Community Garden Workday, workshops, etc.
- Documents - Group charters, meeting minutes, guides
- Physical Resources - Tools, equipment, camping gear
- Skills - Web development, gardening, carpentry
- Mutual Assets - Community van, camera kit, tools
- Badges - Plant Steward, Bike Mechanic, Event Organizer

**Ledger Entries:**
- User registrations
- Group/ring/family memberships
- Resource creation events
- Post and comment interactions
- Governance actions (proposals, polls)

The seed script automatically handles:
- Clearing existing data
- Mapping mock IDs to database UUIDs
- Creating proper relationships and hierarchies
- Generating comprehensive audit logs

**Note:** The seed script will clear all existing data before seeding. Make sure to backup any data you want to keep.

## Environment Variables

Required environment variables (see `src/lib/env.ts`):

- `DATABASE_URL`: PostgreSQL connection string
  - Example: `postgresql://user:password@localhost:5432/rivr`
  - Supports Docker secrets via `DATABASE_URL_FILE`

## Type Safety

All schema types are automatically inferred:

```typescript
import type { Agent, NewAgent, Resource, LedgerEntry } from '@/db';

// Type-safe inserts
const newAgent: NewAgent = {
  name: 'John Doe',
  type: 'person',
  email: 'john@example.com',
};

// Type-safe selects
const agent: Agent = await db.query.agents.findFirst(...);
```

## Best Practices

1. **Always use transactions for multi-table operations**
2. **Use prepared statements** (enabled by default)
3. **Leverage indices** for common query patterns
4. **Use soft deletes** instead of hard deletes
5. **Log all actions** to the ledger table
6. **Use vector search** for semantic queries
7. **Use spatial queries** for location-based features
8. **Use path tracking** for efficient hierarchical queries
