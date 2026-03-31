CREATE TABLE IF NOT EXISTS "federation_entity_map" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "origin_node_id" uuid NOT NULL REFERENCES "nodes"("id"),
  "external_entity_id" text NOT NULL,
  "local_entity_id" uuid NOT NULL,
  "entity_type" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "federation_entity_map_origin_external_type_idx" ON "federation_entity_map" ("origin_node_id", "external_entity_id", "entity_type");
CREATE INDEX IF NOT EXISTS "federation_entity_map_local_entity_idx" ON "federation_entity_map" ("local_entity_id");
CREATE INDEX IF NOT EXISTS "federation_entity_map_origin_node_idx" ON "federation_entity_map" ("origin_node_id");
