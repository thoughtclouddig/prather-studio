CREATE TYPE "public"."broadcast_signal" AS ENUM('SCHEDULED', 'LIVE', 'OFFLINE', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."standing_block_kind" AS ENUM('CTA', 'SPONSOR', 'AFFILIATE', 'CREDENTIAL', 'DISCLAIMER');--> statement-breakpoint
CREATE TABLE "broadcast_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid,
	"provider" "integration_provider" NOT NULL,
	"signal" "broadcast_signal" NOT NULL,
	"external_id" text,
	"observed_at" timestamp with time zone NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "standing_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" uuid NOT NULL,
	"kind" "standing_block_kind" NOT NULL,
	"label" text NOT NULL,
	"body" text NOT NULL,
	"platforms" "publication_platform"[],
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"version" text,
	"hostname" text,
	"pid" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_beat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"jobs_claimed" integer DEFAULT 0 NOT NULL,
	"rejected_reason" text
);
--> statement-breakpoint
ALTER TABLE "episode_content_drafts" ADD COLUMN "source_transcript_id" uuid;--> statement-breakpoint
ALTER TABLE "episode_content_drafts" ADD COLUMN "stale_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "episode_content_drafts" ADD COLUMN "stale_reason" text;--> statement-breakpoint
ALTER TABLE "broadcast_observations" ADD CONSTRAINT "broadcast_observations_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_blocks" ADD CONSTRAINT "standing_blocks_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_observations_dedupe_unique" ON "broadcast_observations" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "broadcast_observations_episode_idx" ON "broadcast_observations" USING btree ("episode_id","observed_at");--> statement-breakpoint
CREATE INDEX "broadcast_observations_provider_idx" ON "broadcast_observations" USING btree ("provider","observed_at");--> statement-breakpoint
CREATE INDEX "standing_blocks_show_idx" ON "standing_blocks" USING btree ("show_id","sort_order");--> statement-breakpoint
CREATE INDEX "worker_heartbeats_beat_idx" ON "worker_heartbeats" USING btree ("last_beat_at");--> statement-breakpoint
ALTER TABLE "episode_content_drafts" ADD CONSTRAINT "episode_content_drafts_source_transcript_id_episode_transcripts_id_fk" FOREIGN KEY ("source_transcript_id") REFERENCES "public"."episode_transcripts"("id") ON DELETE set null ON UPDATE no action;