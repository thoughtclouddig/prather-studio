/**
 * Telling the operator that Jeff has filed.
 *
 * ## Why this goes through the queue
 *
 * The notification is enqueued by the submission, not sent by it. Jeff's form
 * must not be able to fail — or hang — because a mail provider is slow, and he
 * is the one person using this system who cannot be asked to try again. The
 * episode is created either way; the email is a consequence of that, with
 * retries, and if it never arrives the work is still recorded.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodes, settings } from "@/db/schema";
import { appBaseUrl } from "@/lib/app-url";
import { topicLines } from "@/lib/domain/intake";
import { sendNotification } from "@/lib/integrations/resend/client";

export class NoRecipientError extends Error {
  constructor() {
    super(
      "No notification address is set. Add one when connecting Resend in " +
        "Integrations, or set NOTIFY_EMAIL in Secrets.",
    );
    this.name = "NoRecipientError";
  }
}

/**
 * Compose the notice.
 *
 * Plain text, and the whole submission in the body. The point is to be
 * readable on a phone without opening anything — the link is there for when
 * you want to act, not to make you click to find out what was said.
 */
export function composeSubmissionNotice(input: {
  headline: string;
  topics: string[];
  brief: string | null;
  notes: string | null;
  showDate: string;
  episodeUrl: string;
  resubmitted: boolean;
}): { subject: string; text: string } {
  const lines = [
    input.resubmitted
      ? `Jeff resubmitted the show for ${input.showDate}.`
      : `Jeff submitted the show for ${input.showDate}.`,
    "",
    "HEADLINE",
    input.headline,
    "",
    `TOPICS (${input.topics.length})`,
    ...input.topics.map((t) => `  · ${t}`),
  ];

  if (input.brief) lines.push("", "HIS WRITE-UP", input.brief);
  if (input.notes) lines.push("", "ANYTHING ELSE", input.notes);

  lines.push("", "Open the episode:", input.episodeUrl);

  return {
    subject: `${input.resubmitted ? "Resubmitted" : "Show submitted"} — ${input.headline}`,
    text: lines.join("\n"),
  };
}

/** Send the notice for one episode. Throws so the queue can retry. */
export async function sendSubmissionNotice(
  episodeId: string,
  resubmitted: boolean,
): Promise<{ to: string; id: string }> {
  const [episode] = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1);
  if (!episode) throw new Error("Episode not found.");

  const [config] = await db.select().from(settings).where(eq(settings.id, "global")).limit(1);
  // Settings first, then the environment — same order as the credential, so
  // configuring the whole thing through Replit Secrets works end to end.
  const to = config?.notifyEmail?.trim() || process.env.NOTIFY_EMAIL?.trim();
  if (!to) throw new NoRecipientError();

  const notice = composeSubmissionNotice({
    headline: episode.hostHeadline ?? episode.workingTitle,
    topics: topicLines(episode.hostTopics),
    brief: episode.hostBrief,
    notes: episode.hostNotes,
    showDate: episode.scheduledAt
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          weekday: "long",
          month: "long",
          day: "numeric",
        }).format(episode.scheduledAt)
      : "an unscheduled date",
    episodeUrl: `${appBaseUrl()}/studio/episodes/${episodeId}`,
    resubmitted,
  });

  const { id } = await sendNotification({ to, ...notice });
  return { to, id };
}
