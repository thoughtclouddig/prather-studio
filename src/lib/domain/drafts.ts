/**
 * Content draft review.
 *
 * The whole point of this module: PROPOSED content and APPROVED content are
 * different things, and only a human moves a draft between them. Nothing
 * downstream may read a draft that is not APPROVED.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { db } from "@/db/client";
import {
  episodeContentDrafts,
  episodes,
  type EpisodeContentDraft,
  type User,
} from "@/db/schema";
import { authorize } from "@/lib/auth/authorize";
import { recordActivity, SYSTEM_ACTOR, type Actor } from "./activity";
import { fieldLabel } from "./vocabulary";

function actorFor(user: User) {
  return { kind: "user" as const, id: user.id, name: user.name };
}

async function loadDraft(draftId: string): Promise<EpisodeContentDraft> {
  const [draft] = await db
    .select()
    .from(episodeContentDrafts)
    .where(eq(episodeContentDrafts.id, draftId))
    .limit(1);
  if (!draft) throw new Error(`Draft ${draftId} not found`);
  return draft;
}

/**
 * The fields that are candidates to be the show's headline.
 *
 * `primary_headline` is Jeff's own, written verbatim from his submission;
 * `alternate_headline` are the engine's shorter, plainer versions of the same
 * claim. Both are candidates, and which one runs is a human choice.
 */
const HEADLINE_FIELDS = ["primary_headline", "alternate_headline"] as const;

/**
 * Approving a headline is what sets the episode's title.
 *
 * It used to read `primary_headline` only, which meant approving one of the
 * alternates did nothing at all: the draft went green and the episode kept the
 * old title, so the thumbnail and the Rumble listing carried a headline nobody
 * had chosen. Any candidate can now be the one.
 *
 * The choice is exclusive — see `approveDraft`.
 */
async function syncApprovedTitle(episodeId: string): Promise<void> {
  const [approved] = await db
    .select()
    .from(episodeContentDrafts)
    .where(
      and(
        eq(episodeContentDrafts.episodeId, episodeId),
        inArray(episodeContentDrafts.field, [...HEADLINE_FIELDS]),
        eq(episodeContentDrafts.state, "APPROVED"),
      ),
    )
    .orderBy(desc(episodeContentDrafts.approvedAt))
    .limit(1);

  await db
    .update(episodes)
    .set({ approvedTitle: approved?.value ?? null, updatedAt: new Date() })
    .where(eq(episodes.id, episodeId));
}

/**
 * A show has one headline, so approving a second returns the first to the pile.
 *
 * Returned to PROPOSED rather than rejected: changing your mind about which
 * headline to run is not a judgement that the other one was bad, and it should
 * still be there to switch back to.
 */
async function unchooseOtherHeadlines(episodeId: string, keepDraftId: string): Promise<void> {
  await db
    .update(episodeContentDrafts)
    .set({ state: "PROPOSED", approvedBy: null, approvedAt: null })
    .where(
      and(
        eq(episodeContentDrafts.episodeId, episodeId),
        inArray(episodeContentDrafts.field, [...HEADLINE_FIELDS]),
        eq(episodeContentDrafts.state, "APPROVED"),
        ne(episodeContentDrafts.id, keepDraftId),
      ),
    );
}

export async function approveDraft(
  user: User,
  draftId: string,
): Promise<EpisodeContentDraft> {
  authorize(user.role, "draft.approve");
  const draft = await loadDraft(draftId);
  if (draft.state !== "PROPOSED") {
    throw new Error(`Only PROPOSED drafts can be approved (this one is ${draft.state}).`);
  }

  const [updated] = await db
    .update(episodeContentDrafts)
    .set({ state: "APPROVED", approvedBy: user.id, approvedAt: new Date() })
    .where(eq(episodeContentDrafts.id, draftId))
    .returning();

  if ((HEADLINE_FIELDS as readonly string[]).includes(draft.field)) {
    await unchooseOtherHeadlines(draft.episodeId, draftId);
  }

  await syncApprovedTitle(draft.episodeId);
  await recordActivity({
    actor: actorFor(user),
    verb: "draft.approved",
    subjectType: "draft",
    subjectId: draftId,
    episodeId: draft.episodeId,
    summary: `Approved ${fieldLabel(draft.field)}`,
    before: { state: draft.state },
    after: { state: "APPROVED", value: draft.value },
  });
  return updated!;
}

export async function rejectDraft(
  user: User,
  draftId: string,
  reason?: string,
): Promise<EpisodeContentDraft> {
  authorize(user.role, "draft.reject");
  const draft = await loadDraft(draftId);
  if (draft.state !== "PROPOSED") {
    throw new Error(`Only PROPOSED drafts can be rejected (this one is ${draft.state}).`);
  }

  const [updated] = await db
    .update(episodeContentDrafts)
    .set({ state: "REJECTED" })
    .where(eq(episodeContentDrafts.id, draftId))
    .returning();

  await syncApprovedTitle(draft.episodeId);
  await recordActivity({
    actor: actorFor(user),
    verb: "draft.rejected",
    subjectType: "draft",
    subjectId: draftId,
    episodeId: draft.episodeId,
    summary: reason
      ? `Rejected ${fieldLabel(draft.field)} — ${reason}`
      : `Rejected ${fieldLabel(draft.field)}`,
    before: { state: draft.state },
    after: { state: "REJECTED" },
  });
  return updated!;
}

/**
 * Edit-and-approve.
 *
 * The original is SUPERSEDED rather than overwritten, and the replacement is a
 * new row with source HUMAN. What the model proposed and what the operator
 * actually approved both survive — that is the audit trail.
 */
export async function editAndApproveDraft(
  user: User,
  draftId: string,
  newValue: string,
): Promise<EpisodeContentDraft> {
  authorize(user.role, "draft.edit");
  authorize(user.role, "draft.approve");

  const draft = await loadDraft(draftId);
  const value = newValue.trim();
  if (!value) throw new Error("Content cannot be empty.");

  const replacement = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(episodeContentDrafts)
      .values({
        episodeId: draft.episodeId,
        field: draft.field,
        platform: draft.platform,
        value,
        source: "HUMAN",
        state: "APPROVED",
        sortOrder: draft.sortOrder,
        model: draft.model,
        promptVersion: draft.promptVersion,
        approvedBy: user.id,
        approvedAt: new Date(),
      })
      .returning();

    await tx
      .update(episodeContentDrafts)
      .set({ state: "SUPERSEDED", supersededById: created!.id })
      .where(eq(episodeContentDrafts.id, draftId));

    return created!;
  });

  await syncApprovedTitle(draft.episodeId);
  await recordActivity({
    actor: actorFor(user),
    verb: "draft.edited_and_approved",
    subjectType: "draft",
    subjectId: replacement.id,
    episodeId: draft.episodeId,
    summary: `Edited and approved ${fieldLabel(draft.field)}`,
    before: { state: draft.state, value: draft.value },
    after: { state: "APPROVED", value },
  });
  return replacement;
}

/* ---------------------------------------------------------------- staleness */

/**
 * Mark drafts stale when the material they were written from is superseded.
 *
 * Packaging is automatic now, so a draft can outlive its source: a transcript
 * gets re-fetched (a better caption track appears, an operator re-runs it) and
 * every headline, description and chapter list already written describes a
 * recording that is no longer the episode's.
 *
 * Approval is deliberately NOT revoked. A human made that decision and
 * silently undoing it would be worse than the problem — the operator is told
 * the approval now rests on obsolete input and decides for themselves.
 *
 * This is kept proportional on purpose. There is no dependency graph and no
 * invalidation framework: one column recording which transcript a draft came
 * from answers the only question anyone has.
 */
export async function markDraftsStaleForTranscript(
  episodeId: string,
  currentTranscriptId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<number> {
  const now = new Date();
  const stale = await db
    .update(episodeContentDrafts)
    .set({
      staleAt: now,
      staleReason:
        "The transcript this copy was written from has been replaced by a newer one.",
    })
    .where(
      and(
        eq(episodeContentDrafts.episodeId, episodeId),
        isNotNull(episodeContentDrafts.sourceTranscriptId),
        ne(episodeContentDrafts.sourceTranscriptId, currentTranscriptId),
        isNull(episodeContentDrafts.staleAt),
        inArray(episodeContentDrafts.state, ["PROPOSED", "APPROVED"]),
      ),
    )
    .returning({ id: episodeContentDrafts.id, state: episodeContentDrafts.state });

  if (stale.length === 0) return 0;

  const approved = stale.filter((d) => d.state === "APPROVED").length;
  await recordActivity({
    actor,
    verb: "content.stale",
    subjectType: "episode",
    subjectId: episodeId,
    episodeId,
    summary:
      `CONTENT NEEDS RE-REVIEW — ${stale.length} draft(s) were generated from a ` +
      `transcript that has since been replaced` +
      (approved > 0
        ? `, including ${approved} already approved. Approval has not been revoked, ` +
          "but it now rests on material that is no longer the episode's."
        : "."),
    after: { staleCount: stale.length, approvedAffected: approved },
  });

  return stale.length;
}

/** Are any drafts for this episode stale? Drives the Review banner. */
export async function staleDraftCount(episodeId: string): Promise<number> {
  const rows = await db
    .select({ id: episodeContentDrafts.id })
    .from(episodeContentDrafts)
    .where(
      and(
        eq(episodeContentDrafts.episodeId, episodeId),
        isNotNull(episodeContentDrafts.staleAt),
        inArray(episodeContentDrafts.state, ["PROPOSED", "APPROVED"]),
      ),
    );
  return rows.length;
}
