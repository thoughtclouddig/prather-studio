CREATE TYPE "public"."credential_kind" AS ENUM('OAUTH', 'API_KEY', 'URL_SECRET');--> statement-breakpoint
CREATE TYPE "public"."integration_health" AS ENUM('DISCONNECTED', 'CONNECTED', 'ATTENTION');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('YOUTUBE', 'RUMBLE', 'BUZZSPROUT', 'MAILCHIMP', 'OPUSCLIP', 'LOCALS', 'WORDPRESS');--> statement-breakpoint
CREATE TYPE "public"."transcript_source" AS ENUM('YOUTUBE_ASR', 'YOUTUBE_MANUAL', 'WHISPER', 'UPLOAD');--> statement-breakpoint
CREATE TABLE "episode_transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid NOT NULL,
	"source" "transcript_source" NOT NULL,
	"provider" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"raw_text" text NOT NULL,
	"raw_format" text DEFAULT 'vtt' NOT NULL,
	"plain_text" text NOT NULL,
	"source_external_id" text,
	"duration_seconds" integer,
	"segment_count" integer DEFAULT 0 NOT NULL,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"kind" "credential_kind" NOT NULL,
	"encrypted_payload" text NOT NULL,
	"scopes" text[],
	"expires_at" timestamp with time zone,
	"account_label" text,
	"account_external_id" text,
	"health" "integration_health" DEFAULT 'DISCONNECTED' NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"last_observation" jsonb,
	"last_observed_at" timestamp with time zone,
	"connected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transcript_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"start_time" integer NOT NULL,
	"end_time" integer NOT NULL,
	"speaker" text,
	"text" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "episode_transcripts" ADD CONSTRAINT "episode_transcripts_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_transcript_id_episode_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."episode_transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "episode_transcripts_episode_idx" ON "episode_transcripts" USING btree ("episode_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_credentials_provider_unique" ON "integration_credentials" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "transcript_segments_transcript_idx" ON "transcript_segments" USING btree ("transcript_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_segments_ordinal_unique" ON "transcript_segments" USING btree ("transcript_id","ordinal");