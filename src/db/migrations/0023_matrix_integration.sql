-- Matrix integration: agent columns + group chat rooms
CREATE TYPE "public"."chat_mode" AS ENUM('ledger', 'matrix', 'both');--> statement-breakpoint

ALTER TABLE "agents" ADD COLUMN "matrix_user_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "matrix_access_token" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "group_matrix_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_agent_id" uuid NOT NULL,
	"matrix_room_id" text NOT NULL,
	"chat_mode" "chat_mode" DEFAULT 'both' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "group_matrix_rooms" ADD CONSTRAINT "group_matrix_rooms_group_agent_id_agents_id_fk" FOREIGN KEY ("group_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "group_matrix_rooms_group_agent_id_idx" ON "group_matrix_rooms" USING btree ("group_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "group_matrix_rooms_matrix_room_id_idx" ON "group_matrix_rooms" USING btree ("matrix_room_id");
