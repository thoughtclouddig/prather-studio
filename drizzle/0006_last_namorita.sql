CREATE TYPE "public"."pre_stream_state" AS ENUM('NOT_SELECTED', 'SELECTED', 'CONFIRMED_IN_RUMBLE', 'NOT_APPLICABLE');--> statement-breakpoint
CREATE TABLE "pre_stream_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" uuid NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"source_url" text,
	"duration_seconds" integer,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "pre_stream_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "pre_stream_state" "pre_stream_state" DEFAULT 'NOT_SELECTED' NOT NULL;--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "pre_stream_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pre_stream_assets" ADD CONSTRAINT "pre_stream_assets_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pre_stream_assets_show_idx" ON "pre_stream_assets" USING btree ("show_id","sort_order");--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_pre_stream_asset_id_pre_stream_assets_id_fk" FOREIGN KEY ("pre_stream_asset_id") REFERENCES "public"."pre_stream_assets"("id") ON DELETE set null ON UPDATE no action;