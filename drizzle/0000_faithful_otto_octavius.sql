CREATE TYPE "public"."draft_source" AS ENUM('AI', 'HUMAN', 'SEED');--> statement-breakpoint
CREATE TYPE "public"."draft_state" AS ENUM('PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."episode_phase" AS ENUM('PLANNED', 'SCHEDULED', 'LIVE', 'CAPTURING', 'PRODUCING', 'REVIEW', 'RELEASED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."publication_intent" AS ENUM('PUBLISH', 'HOLD', 'SKIP');--> statement-breakpoint
CREATE TYPE "public"."publication_platform" AS ENUM('WEBSITE', 'WORDPRESS', 'YOUTUBE', 'RUMBLE', 'BUZZSPROUT', 'OPUSCLIP', 'LOCALS', 'MAILCHIMP');--> statement-breakpoint
CREATE TYPE "public"."publication_state" AS ENUM('NOT_STARTED', 'READY', 'QUEUED', 'PROCESSING', 'SCHEDULED', 'LIVE', 'PUBLISHED', 'FAILED', 'SKIPPED', 'AWAITING_MANUAL');--> statement-breakpoint
CREATE TYPE "public"."readiness" AS ENUM('PENDING', 'READY', 'MISSING');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('OWNER', 'EDITOR');--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid,
	"actor_user_id" uuid,
	"actor_label" text NOT NULL,
	"verb" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"summary" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episode_content_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid NOT NULL,
	"field" text NOT NULL,
	"platform" "publication_platform",
	"value" text NOT NULL,
	"source" "draft_source" DEFAULT 'AI' NOT NULL,
	"state" "draft_state" DEFAULT 'PROPOSED' NOT NULL,
	"model" text,
	"prompt_version" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"superseded_by_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episode_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid NOT NULL,
	"platform" "publication_platform" NOT NULL,
	"intent" "publication_intent" DEFAULT 'PUBLISH' NOT NULL,
	"state" "publication_state" DEFAULT 'NOT_STARTED' NOT NULL,
	"external_id" text,
	"external_url" text,
	"scheduled_for" timestamp with time zone,
	"published_at" timestamp with time zone,
	"error_message" text,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"episode_number" integer,
	"working_title" text NOT NULL,
	"approved_title" text,
	"scheduled_at" timestamp with time zone,
	"aired_at" timestamp with time zone,
	"phase" "episode_phase" DEFAULT 'PLANNED' NOT NULL,
	"show_prep_state" "readiness" DEFAULT 'PENDING' NOT NULL,
	"artwork_state" "readiness" DEFAULT 'MISSING' NOT NULL,
	"internal_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"episode_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" "job_state" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"last_error" text,
	"result" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"patreon_url" text,
	"locals_url" text,
	"support_url" text,
	"from_name" text,
	"reply_to" text,
	"mailchimp_audience_id" text,
	"default_cta" text,
	"ai_voice_profile" text,
	"ai_voice_notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text,
	"default_start_time" text DEFAULT '14:00' NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"cadence_note" text,
	"credential_line" text,
	"brief_label" text,
	"title_prefix" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"offer" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'EDITOR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode_content_drafts" ADD CONSTRAINT "episode_content_drafts_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode_content_drafts" ADD CONSTRAINT "episode_content_drafts_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode_publications" ADD CONSTRAINT "episode_publications_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsors" ADD CONSTRAINT "sponsors_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_episode_idx" ON "activity_events" USING btree ("episode_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_events_created_idx" ON "activity_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "episode_content_drafts_episode_idx" ON "episode_content_drafts" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX "episode_content_drafts_state_idx" ON "episode_content_drafts" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "episode_publications_episode_platform_unique" ON "episode_publications" USING btree ("episode_id","platform");--> statement-breakpoint
CREATE INDEX "episode_publications_state_idx" ON "episode_publications" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_slug_unique" ON "episodes" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "episodes_show_scheduled_idx" ON "episodes" USING btree ("show_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "episodes_phase_idx" ON "episodes" USING btree ("phase");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key_unique" ON "jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("state","run_after");--> statement-breakpoint
CREATE INDEX "jobs_episode_idx" ON "jobs" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shows_slug_unique" ON "shows" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "sponsors_show_idx" ON "sponsors" USING btree ("show_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));