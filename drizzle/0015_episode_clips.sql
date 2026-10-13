CREATE TABLE IF NOT EXISTS "episode_clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"transcript_text" text,
	"hashtags" text,
	"keywords" text[],
	"duration_seconds" integer,
	"preview_url" text,
	"download_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "episode_clips" ADD CONSTRAINT "episode_clips_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episode_clips_episode_idx" ON "episode_clips" ("episode_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "episode_clips_external_unique" ON "episode_clips" ("external_id");
