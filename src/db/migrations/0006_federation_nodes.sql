-- 1) Visibility enum: add hidden mode
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'visibility_level' AND e.enumlabel = 'hidden'
  ) THEN
    ALTER TYPE visibility_level ADD VALUE 'hidden';
  END IF;
END
$$;

-- 2) Federation enums
DO $$ BEGIN
  CREATE TYPE node_role AS ENUM ('group', 'locale', 'basin', 'global');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE peer_trust_state AS ENUM ('pending', 'trusted', 'blocked');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE node_membership_scope AS ENUM ('group', 'locale', 'basin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE node_membership_status AS ENUM ('pending', 'active', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE federation_event_status AS ENUM ('queued', 'exported', 'imported', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3) Nodes
CREATE TABLE IF NOT EXISTS nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  display_name text NOT NULL,
  role node_role NOT NULL,
  base_url text NOT NULL,
  public_key text,
  is_hosted boolean NOT NULL DEFAULT true,
  owner_agent_id uuid REFERENCES agents(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS nodes_slug_idx ON nodes(slug);
CREATE UNIQUE INDEX IF NOT EXISTS nodes_base_url_idx ON nodes(base_url);
CREATE INDEX IF NOT EXISTS nodes_role_idx ON nodes(role);
CREATE INDEX IF NOT EXISTS nodes_owner_agent_id_idx ON nodes(owner_agent_id);

-- 4) Node peers
CREATE TABLE IF NOT EXISTS node_peers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_node_id uuid NOT NULL REFERENCES nodes(id),
  peer_node_id uuid NOT NULL REFERENCES nodes(id),
  trust_state peer_trust_state NOT NULL DEFAULT 'pending',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS node_peers_unique_pair_idx ON node_peers(local_node_id, peer_node_id);
CREATE INDEX IF NOT EXISTS node_peers_local_node_idx ON node_peers(local_node_id);
CREATE INDEX IF NOT EXISTS node_peers_peer_node_idx ON node_peers(peer_node_id);
CREATE INDEX IF NOT EXISTS node_peers_trust_state_idx ON node_peers(trust_state);

-- 5) Node memberships
CREATE TABLE IF NOT EXISTS node_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id uuid NOT NULL REFERENCES nodes(id),
  member_agent_id uuid NOT NULL REFERENCES agents(id),
  scope node_membership_scope NOT NULL,
  scope_agent_id uuid REFERENCES agents(id),
  role text NOT NULL DEFAULT 'member',
  status node_membership_status NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS node_memberships_node_id_idx ON node_memberships(node_id);
CREATE INDEX IF NOT EXISTS node_memberships_member_agent_id_idx ON node_memberships(member_agent_id);
CREATE INDEX IF NOT EXISTS node_memberships_scope_idx ON node_memberships(scope);
CREATE INDEX IF NOT EXISTS node_memberships_status_idx ON node_memberships(status);

-- 6) Federation events (outbox/inbox)
CREATE TABLE IF NOT EXISTS federation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_node_id uuid NOT NULL REFERENCES nodes(id),
  target_node_id uuid REFERENCES nodes(id),
  entity_type text NOT NULL,
  entity_id uuid,
  event_type text NOT NULL,
  visibility visibility_level NOT NULL DEFAULT 'private',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  signature text,
  status federation_event_status NOT NULL DEFAULT 'queued',
  error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federation_events_origin_node_id_idx ON federation_events(origin_node_id);
CREATE INDEX IF NOT EXISTS federation_events_target_node_id_idx ON federation_events(target_node_id);
CREATE INDEX IF NOT EXISTS federation_events_status_idx ON federation_events(status);
CREATE INDEX IF NOT EXISTS federation_events_entity_type_idx ON federation_events(entity_type);
CREATE INDEX IF NOT EXISTS federation_events_created_at_idx ON federation_events(created_at);
