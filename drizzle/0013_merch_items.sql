CREATE TABLE IF NOT EXISTS "merch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" uuid NOT NULL,
	"printful_id" text NOT NULL,
	"external_id" text,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"image_url" text,
	"price" text,
	"currency" text,
	"featured" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "merch_url_template" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "merch_items" ADD CONSTRAINT "merch_items_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merch_items_show_idx" ON "merch_items" ("show_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merch_items_show_printful_unique" ON "merch_items" ("show_id","printful_id");
