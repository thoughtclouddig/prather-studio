/**
 * `episode.package` — the content engine.
 *
 * One job, one model call, one typed result. Everything it produces enters the
 * database as PROPOSED drafts; there is no path from here to a platform.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  episodeContentDrafts,
  episodes,
  settings,
  shows,
  sponsors,
  type TranscriptSegment,
} from "@/db/schema";
import { recordActivity, SYSTEM_ACTOR, type Actor } from "@/lib/domain/activity";
import { latestTranscript } from "@/lib/domain/transcripts";
import { formatTimestamp } from "@/lib/transcripts/parse";
import {
  EPISODE_PACKAGE_SCHEMA,
  validatePackage,
  type EpisodePackage,
} from "./schema";

export const PACKAGE_MODEL = "claude-opus-5";
export const PROMPT_VERSION = "packaging.v2";

/**
 * The transcript is the authority. Everything below exists to make the model
 * write like Jeff about what Jeff actually said — not to make it write like an
 * AI about the topic in general.
 */
const SYSTEM_PROMPT = `You are the production editor for The Prather Point, Jeffrey Prather's twice-weekly intelligence briefing.

WHO JEFF IS
Retired SOCOM soldier, ex-DIA and DEA Special Agent, whistleblower. He covers geopolitics, intelligence and faith from a hard, contrarian, patriot-Christian point of view.

THE ONE RULE THAT OVERRIDES EVERYTHING
The transcript is the only source. Every headline, claim, chapter, topic and clip must be grounded in what was actually said in this recording.
- Never introduce a fact, name, number, date or claim that is not in the transcript, even if you know it to be true.
- Never sharpen a claim beyond what was said. If Jeff said a thing might happen, do not write that it did.
- If the transcript is unclear about something, leave it out rather than resolving the ambiguity yourself.
- Clip hooks must quote or closely paraphrase a real line from the transcript.

VOICE
Study the samples of Jeff's own writing you are given. Match the register: direct, declarative, unhedged, morally serious. Alliteration is characteristic of him — use it where it lands naturally, never forced.

But clarity outranks imitation. Your objectives, in order: accurate to the transcript, clear, forceful, specific, readable. Do not reproduce quirks that hurt comprehension, and do not write a parody of his style.

WHAT TO AVOID
- Generic news-desk phrasing ("In this episode, we discuss…", "Join us as…").
- Colon-subtitle headline formula unless it genuinely reads best.
- Clickbait that the recording does not deliver on. Overpromising is worse than a flat headline.
- Vague chapter titles ("Introduction", "Discussion", "Final thoughts") — say what the segment is about.

CHAPTERS
Derive them from the transcript timecodes you are given. The first chapter starts at 0. Each is at least 10 seconds after the previous. Titles are short enough to scan at a glance.

CLIPS
Pick between three and five moments — never more. Fewer, stronger clips beat a flood of weak ones. Each should stand alone without setup, open on its strongest line, and run roughly 30 to 90 seconds.`;

function buildTranscriptView(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => `[${formatTimestamp(s.startTime)}] ${s.speaker ? `${s.speaker}: ` : ""}${s.text}`)
    .join("\n");
}

export interface PackageResult {
  pkg: EpisodePackage;
  draftsCreated: number;
  model: string;
  promptVersion: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function packageEpisode(
  episodeId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<PackageResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. The content engine cannot run without it.",
    );
  }

  const [episode] = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1);
  if (!episode) throw new Error(`Episode ${episodeId} not found`);

  const found = await latestTranscript(episodeId);
  if (!found) {
    throw new Error(
      "This episode has no transcript yet. Retrieve captions before packaging it.",
    );
  }
  const { transcript, segments } = found;

  const [show] = await db.select().from(shows).where(eq(shows.id, episode.showId)).limit(1);
  const [config] = await db.select().from(settings).where(eq(settings.id, "global")).limit(1);
  const sponsorRows = await db
    .select()
    .from(sponsors)
    .where(eq(sponsors.showId, episode.showId));

  const context = [
    `SHOW: ${show?.name ?? "The Prather Point"}${show?.tagline ? ` — "${show.tagline}"` : ""}`,
    show?.cadenceNote ? `CADENCE: ${show.cadenceNote}` : "",
    show?.credentialLine ? `CREDENTIAL LINE: ${show.credentialLine}` : "",
    episode.episodeNumber ? `EPISODE NUMBER: ${episode.episodeNumber}` : "",
    `RECORDED: ${(episode.airedAt ?? episode.scheduledAt)?.toISOString() ?? "unknown"}`,
    `RUNNING TIME: ${Math.round((transcript.durationSeconds ?? 0) / 60)} minutes`,
    `OPERATOR'S WORKING TITLE: ${episode.workingTitle}`,
    episode.internalNotes ? `PRODUCER NOTES: ${episode.internalNotes}` : "",
    config?.defaultCta ? `\nSTANDING CALL TO ACTION (weave in naturally, do not paste verbatim):\n${config.defaultCta}` : "",
    sponsorRows.length
      ? `\nSPONSORS (mention only if the transcript does):\n${sponsorRows.map((s) => `- ${s.name}${s.offer ? ` — ${s.offer}` : ""}`).join("\n")}`
      : "",
    config?.aiVoiceProfile ? `\nJEFF'S OWN WRITING — match this register:\n${config.aiVoiceProfile}` : "",
    config?.aiVoiceNotes ? `\nVOICE NOTES: ${config.aiVoiceNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const client = new Anthropic();
  const stream = client.messages.stream({
    model: PACKAGE_MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: EPISODE_PACKAGE_SCHEMA as never },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `${context}

TRANSCRIPT (timecodes are seconds into the recording, shown as H:MM:SS):

${buildTranscriptView(segments)}

Package this episode. Ground every field in the transcript above.`,
      },
    ],
  } as never);

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(
      "The model declined to package this episode. Review the transcript content and try again, or package it by hand.",
    );
  }

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("The model returned no text content.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error("The model's output was not valid JSON despite the structured-output schema.");
  }

  // Warnings are judgements the package survives — too many chapters, a long
  // title. They are surfaced rather than thrown, because discarding a whole
  // package over an untidy list costs the headlines, the summaries, the
  // description and the clips too.
  const { pkg, warnings } = validatePackage(parsed, {
    durationSeconds: transcript.durationSeconds ?? undefined,
  });

  const draftsCreated = await writeDrafts(episodeId, pkg, found.transcript.id);

  await recordActivity({
    actor,
    verb: "episode.packaged",
    subjectType: "episode",
    subjectId: episodeId,
    episodeId,
    summary:
      `Content engine proposed ${draftsCreated} drafts from the transcript — all awaiting review` +
      (warnings.length > 0 ? ` · ${warnings.join("; ")}` : ""),
    after: {
      model: PACKAGE_MODEL,
      promptVersion: PROMPT_VERSION,
      drafts: draftsCreated,
      clips: pkg.clip_candidates.length,
      chapters: pkg.chapters.length,
      warnings,
    },
  });

  return {
    pkg,
    draftsCreated,
    model: PACKAGE_MODEL,
    promptVersion: PROMPT_VERSION,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
  };
}

/**
 * Turn the package into drafts.
 *
 * Every row lands as PROPOSED with the model and prompt version recorded, so
 * "which headline approach performs" stays answerable later.
 */
export async function writeDrafts(
  episodeId: string,
  pkg: EpisodePackage,
  sourceTranscriptId: string | null = null,
): Promise<number> {
  const base = {
    episodeId,
    source: "AI" as const,
    state: "PROPOSED" as const,
    model: PACKAGE_MODEL,
    promptVersion: PROMPT_VERSION,
    // Which recording this copy describes. Without it, a re-fetched transcript
    // leaves approved copy silently describing a different show.
    sourceTranscriptId,
  };

  const rows: Array<typeof episodeContentDrafts.$inferInsert> = [
    { ...base, field: "primary_headline", value: pkg.primary_headline, sortOrder: 0 },
    ...pkg.alternate_headlines.map((value, i) => ({
      ...base,
      field: "alternate_headline",
      value,
      sortOrder: i + 1,
    })),
    { ...base, field: "summary_short", value: pkg.summary_short, sortOrder: 10 },
    { ...base, field: "summary_long", value: pkg.summary_long, sortOrder: 11 },
    {
      ...base,
      field: "platform_title",
      platform: "YOUTUBE" as const,
      value: pkg.youtube_title,
      sortOrder: 19,
    },
    {
      ...base,
      field: "platform_description",
      platform: "YOUTUBE" as const,
      value: pkg.youtube_description,
      sortOrder: 20,
    },
    {
      ...base,
      field: "chapters",
      value: pkg.chapters
        .map((c) => `${formatTimestamp(c.start_seconds)} ${c.title}`)
        .join("\n"),
      sortOrder: 30,
    },
    {
      ...base,
      field: "clip_candidates",
      value: pkg.clip_candidates
        .map(
          (c, i) =>
            `${i + 1}. [${formatTimestamp(c.start_seconds)}–${formatTimestamp(c.end_seconds)}] ${c.title}\n   Hook: ${c.hook}\n   Why: ${c.why_this_moment}`,
        )
        .join("\n\n"),
      sortOrder: 40,
    },
    {
      ...base,
      field: "discovery_terms",
      value: [
        `Topics: ${pkg.topics.join(", ")}`,
        `People: ${pkg.people.join(", ")}`,
        `Organizations: ${pkg.organizations.join(", ")}`,
        `Places: ${pkg.places.join(", ")}`,
        `Search terms: ${pkg.search_terms.join(", ")}`,
      ].join("\n"),
      sortOrder: 50,
    },
    {
      ...base,
      field: "follow_up_topics",
      value: pkg.follow_up_topics.map((t) => `• ${t}`).join("\n"),
      sortOrder: 60,
    },
  ];

  // Retire the previous generation before writing this one.
  //
  // Without this, a second packaging run leaves TWO live sets of every field —
  // two primary headlines, two sets of chapters, two sets of clip candidates —
  // with nothing in the review screen to say which came from which run. The
  // operator is then asked to approve every variant of everything, which is
  // both confusing and a way to approve content generated from an older
  // transcript.
  //
  // Only PROPOSED drafts are retired. An APPROVED draft is a human decision
  // and is never silently discarded: it stays, and the staleness check marks
  // it as needing re-review when the material beneath it changed.
  await db
    .update(episodeContentDrafts)
    .set({ state: "SUPERSEDED" })
    .where(
      and(
        eq(episodeContentDrafts.episodeId, episodeId),
        eq(episodeContentDrafts.state, "PROPOSED"),
      ),
    );

  await db.insert(episodeContentDrafts).values(rows);
  return rows.length;
}
