/**
 * Building the briefing campaign in Mailchimp.
 *
 * ## The one irreversible step in the system
 *
 * Everything else here can be undone: a YouTube title can be rewritten, a
 * WordPress post stays a draft, a Buzzsprout episode can be corrected. A
 * Mailchimp campaign that has gone out has gone out, to the whole list, and no
 * part of it can be recalled. So this module is deliberately more suspicious
 * than its siblings:
 *
 *  · It reads APPROVED drafts only. A PROPOSED subject line is a machine's
 *    suggestion, and the editorial rule is that a human chooses.
 *  · It creates a DRAFT and SCHEDULES it. It never sends.
 *  · It refuses a send time that has already passed rather than quietly
 *    moving it. A briefing arriving at an hour nobody chose is worse than one
 *    that did not go out, because only the second is noticed.
 *
 * ## Where the send time comes from
 *
 * `resolveSendTime` — a wall-clock time in a named zone, from Settings,
 * defaulting to 11:00 America/Phoenix. Not a constant and not an offset from
 * air time; see the comment on that module for why both of those break in
 * November while looking correct in October.
 */
import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  episodeContentDrafts,
  episodePublications,
  episodes,
  settings,
  shows,
  sponsors,
  type User,
} from "@/db/schema";
import { recordActivity, type Actor } from "@/lib/domain/activity";
import { topicLines } from "@/lib/domain/intake";
import {
  renderBriefingEmail,
  renderBriefingText,
  type BriefingEmail,
} from "@/lib/email/template";
import { describeGap, resolveSendTime, type ResolvedSendTime } from "@/lib/email/send-time";
import {
  createCampaign,
  scheduleCampaign,
  setCampaignContent,
} from "@/lib/integrations/mailchimp/client";

const actorFor = (user: User): Actor => ({ kind: "user", id: user.id, name: user.name });

export class BriefingNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriefingNotReadyError";
  }
}

export interface BriefingPreview {
  email: BriefingEmail;
  html: string;
  text: string;
  sendTime: ResolvedSendTime;
  /** "11:00 AM MST — as the show starts" */
  sendSummary: string;
  /** What is still missing. Empty means it can be scheduled. */
  blockers: string[];
}

/**
 * Assemble the briefing without touching Mailchimp.
 *
 * Pure read, so the Studio can show the real email — the same HTML that would
 * be uploaded — before anyone commits to sending it. Reviewing a description
 * of an email is not reviewing the email.
 */
export async function previewBriefing(episodeId: string): Promise<BriefingPreview> {
  const [episode] = await db
    .select()
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1);
  if (!episode) throw new BriefingNotReadyError("Episode not found.");

  const [show] = await db.select().from(shows).where(eq(shows.id, episode.showId)).limit(1);
  const [config] = await db.select().from(settings).where(eq(settings.id, "global")).limit(1);

  const approved = await db
    .select()
    .from(episodeContentDrafts)
    .where(
      and(
        eq(episodeContentDrafts.episodeId, episodeId),
        eq(episodeContentDrafts.state, "APPROVED"),
      ),
    )
    .orderBy(asc(episodeContentDrafts.sortOrder), desc(episodeContentDrafts.approvedAt));

  const pick = (field: string): string | null =>
    approved.find((d) => d.field === field)?.value?.trim() || null;

  const blockers: string[] = [];

  const subject = pick("email_subject");
  if (!subject) blockers.push("No subject line is approved yet.");

  const brief = pick("email_brief") ?? episode.hostBrief?.trim() ?? null;
  if (!brief) blockers.push("No brief is approved yet, and Jeff did not supply one.");

  // Bullets fall back to Jeff's own topics. His list is the source; the engine
  // only proofreads it, so an unapproved correction is no reason to send an
  // email with nothing in it.
  const approvedBullets = pick("email_bullets");
  const bullets = approvedBullets
    ? topicLines(approvedBullets)
    : topicLines(episode.hostTopics);
  if (bullets.length === 0) blockers.push("There are no topics to list.");

  if (!episode.scheduledAt) blockers.push("This episode has no air date.");

  const sponsorRows = show
    ? await db
        .select()
        .from(sponsors)
        .where(and(eq(sponsors.showId, show.id), eq(sponsors.active, true)))
        .orderBy(asc(sponsors.sortOrder))
    : [];

  const watchUrl = await resolveWatchUrl(episodeId);

  const airAt = episode.scheduledAt ?? new Date();
  const sendTime = resolveSendTime({
    scheduledAt: airAt,
    sendTime: config?.emailSendTime,
    sendTimezone: config?.emailSendTimezone,
  });

  if (sendTime.isPast) {
    blockers.push(
      `The ${sendTime.label} send time for this episode has already passed. ` +
        `Pick a new time rather than letting it go out at an hour nobody chose.`,
    );
  }

  const email: BriefingEmail = {
    headline: subject ?? episode.hostHeadline ?? episode.workingTitle,
    brief: brief ?? "",
    bullets,
    watchUrl,
    dateLabel: formatDate(airAt, show?.timezone ?? "America/New_York"),
    airTimeLabel: formatAirTime(airAt, show?.timezone ?? "America/New_York"),
    credentialLine: show?.credentialLine ?? "",
    sponsors: sponsorRows.map((s) => ({ name: s.name, url: s.url, offer: s.offer })),
    patreonUrl: config?.patreonUrl ?? null,
    signOff: pick("email_preview"),
  };

  return {
    email,
    html: renderBriefingEmail(email),
    text: renderBriefingText(email),
    sendTime,
    sendSummary: `${sendTime.label} — ${describeGap(sendTime.gapToAirMinutes)}`,
    blockers,
  };
}

export interface ScheduledBriefing {
  campaignId: string;
  webId: number | null;
  scheduledFor: Date;
  sendSummary: string;
}

/**
 * Create the draft campaign and schedule it.
 *
 * Returns only after Mailchimp has confirmed the schedule, so the Studio never
 * claims a send that did not take.
 */
export async function scheduleBriefingCampaign(
  episodeId: string,
  user: User,
): Promise<ScheduledBriefing> {
  const preview = await previewBriefing(episodeId);

  if (preview.blockers.length > 0) {
    throw new BriefingNotReadyError(
      `This briefing is not ready to schedule:\n· ${preview.blockers.join("\n· ")}`,
    );
  }

  const [config] = await db.select().from(settings).where(eq(settings.id, "global")).limit(1);

  const campaign = await createCampaign({
    subjectLine: preview.email.headline,
    previewText: preview.email.signOff ?? "",
    title: `Briefing — ${preview.email.dateLabel}`,
    fromName: config?.fromName ?? "Jeffrey Prather",
    replyTo: config?.replyTo ?? "",
  });

  await setCampaignContent(campaign.id, preview.html, preview.text);

  const { scheduledFor } = await scheduleCampaign(campaign.id, preview.sendTime.at);

  await db
    .insert(episodePublications)
    .values({
      episodeId,
      platform: "MAILCHIMP",
      state: "SCHEDULED",
      externalId: campaign.id,
      externalUrl: campaign.webId
        ? `https://admin.mailchimp.com/campaigns/edit?id=${campaign.webId}`
        : null,
    })
    .onConflictDoUpdate({
      target: [episodePublications.episodeId, episodePublications.platform],
      set: {
        state: "SCHEDULED",
        externalId: campaign.id,
        updatedAt: new Date(),
      },
    });

  await recordActivity({
    actor: actorFor(user),
    verb: "episode.briefing_scheduled",
    subjectType: "episode",
    subjectId: episodeId,
    episodeId,
    summary:
      `Scheduled the briefing for ${preview.sendTime.label} ` +
      `(${describeGap(preview.sendTime.gapToAirMinutes)})`,
    after: {
      campaignId: campaign.id,
      scheduledFor: scheduledFor.toISOString(),
      sendTime: preview.sendTime.wallTime,
      sendTimezone: preview.sendTime.zone,
    },
  });

  return {
    campaignId: campaign.id,
    webId: campaign.webId,
    scheduledFor,
    sendSummary: preview.sendSummary,
  };
}

/** Rumble first — it is where the audience is sent — then YouTube. */
async function resolveWatchUrl(episodeId: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(episodePublications)
    .where(eq(episodePublications.episodeId, episodeId));

  for (const platform of ["RUMBLE", "YOUTUBE"] as const) {
    const url = rows.find((r) => r.platform === platform)?.externalUrl;
    if (url) return url;
  }
  return null;
}

function formatDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(instant);
}

function formatAirTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(instant);
}
