/**
 * The host's submission — where an episode actually begins.
 *
 * Jeff fills a short form in the morning: the date, his headline, the topics
 * as bullet points, and his own write-up for the email. That submission
 * CREATES the episode, rather than landing in a separate system someone later
 * copies across.
 *
 * ## Why this replaced a separate app
 *
 * The intake used to live in its own Replit project with its own database.
 * Everything Jeff wrote had to be carried over by hand, and the Studio sat
 * inert all morning waiting for a transcript that could not exist until the
 * show had happened — while the material needed to write headlines, the email
 * and the post was already sitting in another browser tab.
 *
 * ## What is stored verbatim, and why that matters
 *
 * `hostHeadline`, `hostTopics` and `hostBrief` are kept exactly as typed and
 * are never overwritten by generated copy. The editorial rule is that Jeff's
 * writing is PROOFREAD, not replaced: the engine produces alternates ALONGSIDE
 * his headline and corrections TO his prose, and an operator chooses. Keeping
 * the originals in their own columns is what makes "what did Jeff actually
 * say" answerable after any amount of editing.
 */
import "server-only";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db/client";
import { episodes, shows } from "@/db/schema";
import { recordActivity } from "@/lib/domain/activity";
import { createEpisodeRecord } from "@/lib/domain/create-episode";
import { cadenceFrom } from "@/lib/domain/schedule";
import { parseWallTime, zonedTimeToInstant } from "@/lib/time/zone";

export interface HostSubmission {
  /** `YYYY-MM-DD`, as the date input gives it. */
  showDate: string;
  headline: string;
  /** One per line, exactly as typed. */
  topics: string;
  /** His own paragraphs for the email. Optional — sometimes it comes later. */
  brief?: string;
  notes?: string;
}

export class IntakeError extends Error {}

/**
 * Turn a submitted date into the show's actual start instant.
 *
 * The show airs at a wall-clock time in the show's own zone, so the date alone
 * is not enough — and a fixed UTC offset would drift across the DST change.
 * This is the same zone arithmetic the schedule uses, deliberately: an episode
 * created by the host and one created from the cadence must land on the same
 * instant, or the matcher sees two different shows.
 */
async function scheduledAtFor(showDate: string): Promise<{ at: Date; showId: string }> {
  const [show] = await db.select().from(shows).limit(1);
  if (!show) {
    throw new IntakeError("No show is configured yet. Run bootstrap:show.");
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(showDate.trim());
  if (!match) throw new IntakeError("Pick a show date.");

  const cadence = cadenceFrom(show);
  const { hour, minute } = parseWallTime(cadence.startTime);

  return {
    at: zonedTimeToInstant(
      {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour,
        minute,
      },
      cadence.timeZone,
    ),
    showId: show.id,
  };
}

/** An episode already scheduled within this window is the same show. */
const SAME_SHOW_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Record a submission, creating or updating the episode for that date.
 *
 * Re-submitting the same date UPDATES rather than duplicating. Jeff sends a
 * correction more often than he sends a second show, and two episodes for one
 * broadcast would split everything downstream — the match, the transcript, the
 * post — in a way that is tedious to unpick.
 */
export async function recordHostSubmission(
  submission: HostSubmission,
): Promise<{ episodeId: string; created: boolean }> {
  const headline = submission.headline.trim();
  if (!headline) throw new IntakeError("Add a headline for today's show.");

  const topics = submission.topics.trim();
  if (!topics) throw new IntakeError("Add at least one topic.");

  const { at, showId } = await scheduledAtFor(submission.showDate);
  const now = new Date();

  const [existing] = await db
    .select({ id: episodes.id })
    .from(episodes)
    .where(
      and(
        eq(episodes.showId, showId),
        gte(episodes.scheduledAt, new Date(at.getTime() - SAME_SHOW_WINDOW_MS)),
        lte(episodes.scheduledAt, new Date(at.getTime() + SAME_SHOW_WINDOW_MS)),
      ),
    )
    .limit(1);

  const hostFields = {
    hostHeadline: headline,
    hostTopics: topics,
    hostBrief: submission.brief?.trim() || null,
    hostNotes: submission.notes?.trim() || null,
    submittedAt: now,
  };

  if (existing) {
    await db
      .update(episodes)
      .set({ ...hostFields, updatedAt: now })
      .where(eq(episodes.id, existing.id));

    await recordActivity({
      actor: { kind: "system", label: "host intake" },
      verb: "episode.host_resubmitted",
      subjectType: "episode",
      subjectId: existing.id,
      episodeId: existing.id,
      summary: `Jeff resubmitted the show details — "${headline}"`,
      after: hostFields,
    });

    return { episodeId: existing.id, created: false };
  }

  // The working title is HIS headline. It is what everyone refers to the show
  // by until an editorial headline is approved, and inventing a placeholder
  // here would mean the episode is briefly called something nobody said.
  const episode = await createEpisodeRecord({
    showId,
    workingTitle: headline,
    scheduledAt: at,
  });

  await db
    .update(episodes)
    .set({ ...hostFields, updatedAt: now })
    .where(eq(episodes.id, episode.id));

  await recordActivity({
    actor: { kind: "system", label: "host intake" },
    verb: "episode.host_submitted",
    subjectType: "episode",
    subjectId: episode.id,
    episodeId: episode.id,
    summary: `Jeff submitted the show — "${headline}"`,
    after: hostFields,
  });

  return { episodeId: episode.id, created: true };
}

/** Topics as a list, for rendering. Blank lines and bullet characters dropped. */
export function topicLines(topics: string | null): string[] {
  if (!topics) return [];
  return topics
    .split("\n")
    .map((line) => line.replace(/^\s*[-•*–]\s*/, "").trim())
    .filter(Boolean);
}
