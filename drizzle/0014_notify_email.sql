ALTER TYPE "integration_provider" ADD VALUE IF NOT EXISTS 'RESEND';--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "notify_email" text;
