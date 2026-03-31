DROP INDEX IF EXISTS "agents_path_ids_idx";
CREATE INDEX IF NOT EXISTS "agents_path_ids_gin_idx" ON "agents" USING gin ("path_ids");

DROP INDEX IF EXISTS "resources_tags_idx";
CREATE INDEX IF NOT EXISTS "resources_tags_gin_idx" ON "resources" USING gin ("tags");
