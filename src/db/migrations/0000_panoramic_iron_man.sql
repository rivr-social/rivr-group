CREATE TYPE "public"."agent_type" AS ENUM('person', 'organization', 'project', 'event', 'place', 'system');--> statement-breakpoint
CREATE TYPE "public"."resource_type" AS ENUM('document', 'image', 'video', 'audio', 'link', 'note', 'file', 'dataset');--> statement-breakpoint
CREATE TYPE "public"."verb_type" AS ENUM('create', 'update', 'delete', 'transfer', 'share', 'view', 'clone', 'merge', 'split');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "agent_type" NOT NULL,
	"description" text,
	"email" text,
	"password_hash" text,
	"email_verified" timestamp with time zone,
	"image" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"parent_id" uuid,
	"path_ids" uuid[],
	"depth" integer DEFAULT 0 NOT NULL,
	"location" geometry(Point, 4326),
	"embedding" vector(1536),
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verb" "verb_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"object_id" uuid,
	"object_type" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"resource_id" uuid,
	"session_id" text,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "resource_type" NOT NULL,
	"description" text,
	"content" text,
	"content_type" text,
	"url" text,
	"storage_key" text,
	"storage_provider" text DEFAULT 'minio',
	"file_size" integer,
	"owner_id" uuid NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"tags" text[] DEFAULT '{}',
	"embedding" vector(1536),
	"location" geometry(Point, 4326),
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_subject_id_agents_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_owner_id_agents_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_name_idx" ON "agents" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_email_idx" ON "agents" USING btree ("email");--> statement-breakpoint
CREATE INDEX "agents_type_idx" ON "agents" USING btree ("type");--> statement-breakpoint
CREATE INDEX "agents_parent_id_idx" ON "agents" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "agents_path_ids_idx" ON "agents" USING btree ("path_ids");--> statement-breakpoint
CREATE INDEX "agents_location_gist_idx" ON "agents" USING gist ("location");--> statement-breakpoint
CREATE INDEX "agents_embedding_hnsw_idx" ON "agents" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "agents_deleted_at_idx" ON "agents" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "agents_created_at_idx" ON "agents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ledger_verb_idx" ON "ledger" USING btree ("verb");--> statement-breakpoint
CREATE INDEX "ledger_subject_id_idx" ON "ledger" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "ledger_object_id_idx" ON "ledger" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "ledger_resource_id_idx" ON "ledger" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "ledger_timestamp_idx" ON "ledger" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "ledger_session_id_idx" ON "ledger" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ledger_subject_verb_idx" ON "ledger" USING btree ("subject_id","verb");--> statement-breakpoint
CREATE INDEX "ledger_object_type_object_id_idx" ON "ledger" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "resources_name_idx" ON "resources" USING btree ("name");--> statement-breakpoint
CREATE INDEX "resources_type_idx" ON "resources" USING btree ("type");--> statement-breakpoint
CREATE INDEX "resources_owner_id_idx" ON "resources" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "resources_tags_idx" ON "resources" USING btree ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "resources_storage_key_idx" ON "resources" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "resources_embedding_hnsw_idx" ON "resources" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "resources_location_gist_idx" ON "resources" USING gist ("location");--> statement-breakpoint
CREATE INDEX "resources_deleted_at_idx" ON "resources" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "resources_created_at_idx" ON "resources" USING btree ("created_at");