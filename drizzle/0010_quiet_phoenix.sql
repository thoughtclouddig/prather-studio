ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "email_send_time" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "email_send_timezone" text;--> statement-breakpoint
UPDATE "settings" SET "email_send_time" = '11:00', "email_send_timezone" = 'America/Phoenix' WHERE "email_send_time" IS NULL;
