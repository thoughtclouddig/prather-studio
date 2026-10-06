/**
 * `episode.pre_show` — the engine that runs BEFORE the broadcast.
 *
 * ## Why there are two engines
 *
 * The packaging engine reads a transcript, so it cannot run until the show has
 * happened. But Jeff submits his headline, his topics and his own write-up in
 * the morning, and everything the email needs is already in that submission.
 * Waiting for a recording to write an email that goes out at 12:45 — before the
 * 2pm show — was the wrong order, and it is why the intake lived in a separate
 * app for months.
 *
 * So: this reads the SUBMISSION. The packaging engine still reads the
 * transcript afterwards for chapters, clips and the description. Two sources,
 * two moments, one episode.
 *
 * ## The editorial rule, enforced in the prompt
 *
 * Jeff is PROOFREAD, NOT REWRITTEN. That is not a style preference — it is the
 * reason people subscribe. So:
 *
 *  · His topics are corrected for spelling and grammar and otherwise left
 *    exactly as written. "Netanyuahu" becomes "Netanyahu"; his phrasing stays.
 *  · His brief is generated in his register when he supplies notes, and his
 *    original is kept verbatim beside it so an operator can swap the generated
 *    one out entirely. Neither is discarded.
 *  · The subject lines are VARIATIONS ON HIS HEADLINE, not replacements for it.
 *    His headline is often long or arcane for an inbox; these are three
 *    attempts at the same claim with curiosity in front.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { episodeContentDrafts, episodes, settings } from "@/db/schema";
import { recordActivity } from "@/lib/domain/activity";
import { topicLines } from "@/lib/domain/intake";

export const PRE_SHOW_PROMPT_VERSION = "pre-show.v1";
const PRE_SHOW_MODEL = "claude-opus-5";

/** Three. Not four — more options is not more useful, it is more to read. */
const SUBJECT_COUNT = 3;

const SYSTEM_PROMPT = `You prepare the pre-show email for The Prather Point, a daily \
intelligence briefing hosted by Jeffrey Prather — retired Major, ex-DIA and ex-DEA. The \
audience is his, and they subscribe because he sounds like himself.

THE RULE THAT MATTERS MOST: you proofread Jeff, you do not rewrite him. His phrasing, his \
rhythm and his word choices stay. You fix spelling and grammar. You do not smooth his \
voice into house style, soften his claims, or make him sound like a newsletter.

You never invent facts. Everything you write comes from what he submitted. If his notes \
do not support a claim, it does not appear.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject_lines", "preview_text", "brief", "bullets"],
  properties: {
    subject_lines: {
      type: "array",
      description:
        "Exactly three variations on HIS headline — the same claim, reordered or " +
        "sharpened so it creates curiosity in an inbox. Not replacements for his " +
        "angle, and never clickbait that the show does not deliver. Under 65 " +
        "characters each so they are not truncated.",
      items: { type: "string" },
    },
    preview_text: {
      type: "string",
      description:
        "The line beneath the subject in an inbox. It must ADD to the subject " +
        "rather than repeat it — usually the most arresting single fact from his " +
        "topics. Under 110 characters.",
    },
    brief: {
      type: "string",
      description:
        "Two or three short paragraphs in Jeff's own register, built from his " +
        "notes. First person. If he supplied a write-up, stay close to his " +
        "sentences and fix only what is wrong. Ends with a line that makes the " +
        "reader want to watch.",
    },
    bullets: {
      type: "array",
      description:
        "His topics, one per line, corrected for spelling and grammar ONLY. Same " +
        "order, same count, same phrasing. Do not merge, reword, re-rank or " +
        "editorialise them. This is the field where restraint matters most.",
      items: { type: "string" },
    },
  },
} as const;

export interface PreShowPackage {
  subject_lines: string[];
  preview_text: string;
  brief: string;
  bullets: string[];
}

export class NoSubmissionError extends Error {
  constructor() {
    super("This episode has no submission from Jeff yet, so there is nothing to prepare.");
    this.name = "NoSubmissionError";
  }
}

/** Generate and store the pre-show drafts. Returns how many were written. */
export async function runPreShow(episodeId: string): Promise<number> {
  const [episode] = await db
    .select()
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1);
  if (!episode) throw new Error("Episode not found.");

  if (!episode.hostHeadline || !episode.hostTopics) {
    throw new NoSubmissionError();
  }

  const [config] = await db.select().from(settings).where(eq(settings.id, "global")).limit(1);
  const topics = topicLines(episode.hostTopics);

  const context = [
    `SHOW DATE: ${episode.scheduledAt?.toISOString().slice(0, 10) ?? "unscheduled"}`,
    ``,
    `JEFF'S HEADLINE, exactly as he wrote it:`,
    episode.hostHeadline,
    ``,
    `HIS TOPICS, one per line, exactly as he wrote them:`,
    ...topics.map((t) => `- ${t}`),
    episode.hostBrief
      ? `\nHIS OWN WRITE-UP FOR THE EMAIL — stay close to this, correct only what is wrong:\n${episode.hostBrief}`
      : `\nHe did not supply a write-up. Build the brief from his topics and notes, in his register.`,
    episode.hostNotes ? `\nANYTHING ELSE HE ADDED:\n${episode.hostNotes}` : "",
    config?.aiVoiceProfile
      ? `\nJEFF'S OWN WRITING — match this register:\n${config.aiVoiceProfile}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const client = new Anthropic();
  const stream = client.messages.stream({
    model: PRE_SHOW_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: SCHEMA as never },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `${context}

Prepare the pre-show email. Exactly ${SUBJECT_COUNT} subject lines, each a variation on \
HIS headline that creates curiosity. Keep his bullets as his — spelling and grammar only.`,
      },
    ],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(
      "The model declined to prepare this email. Review what Jeff submitted, or write it by hand.",
    );
  }

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("The model returned no text content.");
  }

  const pkg = JSON.parse(textBlock.text) as PreShowPackage;
  validate(pkg, topics.length);

  // Retire the previous pre-show generation. Approved drafts survive — a human
  // decision is not discarded by a re-run; the staleness check flags those.
  await db
    .update(episodeContentDrafts)
    .set({ state: "SUPERSEDED" })
    .where(
      and(
        eq(episodeContentDrafts.episodeId, episodeId),
        eq(episodeContentDrafts.state, "PROPOSED"),
        ne(episodeContentDrafts.field, "primary_headline"),
      ),
    );

  const base = {
    episodeId,
    source: "AI" as const,
    state: "PROPOSED" as const,
    model: PRE_SHOW_MODEL,
    promptVersion: PRE_SHOW_PROMPT_VERSION,
  };

  const rows = [
    ...pkg.subject_lines.map((value, index) => ({
      ...base,
      field: "email_subject",
      value,
      sortOrder: index,
    })),
    { ...base, field: "email_preview", value: pkg.preview_text, sortOrder: 10 },
    { ...base, field: "email_brief", value: pkg.brief, sortOrder: 20 },
    {
      ...base,
      field: "email_bullets",
      value: pkg.bullets.join("\n"),
      sortOrder: 30,
    },
  ];

  await db.insert(episodeContentDrafts).values(rows);

  await recordActivity({
    actor: { kind: "system", label: "pre-show engine" },
    verb: "episode.pre_show_prepared",
    subjectType: "episode",
    subjectId: episodeId,
    episodeId,
    summary:
      `Prepared the pre-show email from Jeff's submission — ` +
      `${pkg.subject_lines.length} subject lines, a brief and ${pkg.bullets.length} bullets`,
    after: { promptVersion: PRE_SHOW_PROMPT_VERSION, drafts: rows.length },
  });

  return rows.length;
}

/**
 * Check what the model returned.
 *
 * The bullet count is the one that matters. Dropping or merging Jeff's topics
 * is the failure that would be hardest to notice — the email would read fine
 * and simply be missing something he said he was covering.
 */
function validate(pkg: PreShowPackage, expectedBullets: number): void {
  if (!Array.isArray(pkg.subject_lines) || pkg.subject_lines.length === 0) {
    throw new Error("The engine returned no subject lines.");
  }
  if (!pkg.brief?.trim()) {
    throw new Error("The engine returned an empty brief.");
  }
  if (!Array.isArray(pkg.bullets) || pkg.bullets.length !== expectedBullets) {
    throw new Error(
      `Jeff submitted ${expectedBullets} topics but the engine returned ` +
        `${pkg.bullets?.length ?? 0} bullets. His topics are passed through, not edited ` +
        `down — refusing rather than silently dropping one.`,
    );
  }
}
