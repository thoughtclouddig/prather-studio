ALTER TABLE "episode_publications" ADD COLUMN "remote_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "episode_publications" ADD COLUMN "remote_snapshot_at" timestamp with time zone;