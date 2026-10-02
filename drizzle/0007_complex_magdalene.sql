CREATE TYPE "public"."metric_subject" AS ENUM('CHANNEL', 'EPISODE', 'PODCAST');--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"subject" "metric_subject" NOT NULL,
	"external_id" text,
	"episode_id" uuid,
	"captured_at" timestamp with time zone NOT NULL,
	"counters" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "metric_snapshots_dedupe_unique" ON "metric_snapshots" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "metric_snapshots_lookup_idx" ON "metric_snapshots" USING btree ("provider","subject","captured_at");--> statement-breakpoint
CREATE INDEX "metric_snapshots_episode_idx" ON "metric_snapshots" USING btree ("episode_id","captured_at");