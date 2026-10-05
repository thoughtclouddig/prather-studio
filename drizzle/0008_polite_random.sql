CREATE TYPE "public"."episode_image_kind" AS ENUM('GUEST_PHOTO', 'ARTWORK', 'THUMBNAIL_16_9', 'THUMBNAIL_1_1');--> statement-breakpoint
CREATE TYPE "public"."episode_image_state" AS ENUM('PROPOSED', 'ACCEPTED', 'SUPERSEDED');--> statement-breakpoint
CREATE TABLE "episode_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid NOT NULL,
	"kind" "episode_image_kind" NOT NULL,
	"state" "episode_image_state" DEFAULT 'PROPOSED' NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"prompt" text,
	"model" text,
	"derived_from_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "guest_name" text;--> statement-breakpoint
ALTER TABLE "episode_images" ADD CONSTRAINT "episode_images_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode_images" ADD CONSTRAINT "episode_images_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "episode_images_episode_idx" ON "episode_images" USING btree ("episode_id","kind");