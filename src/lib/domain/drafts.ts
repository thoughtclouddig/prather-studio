/**
 * Content draft review.
 *
 * The whole point of this module: PROPOSED content and APPROVED content are
 * different things, and only a human moves a draft between them. Nothing
 * downstream may read a draft that is not APPROVED.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  episodeContentDrafts,
  episodes,
  type EpisodeContentDraft,
  type User,
} from "@/db/schema";
import { authorize } from "@/lib/auth/authorize";
import { recordActivity } from "./activity";
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
 * Approving the primary headline is what sets the episode's approved title.
 * That is the one place a draft becomes canonical, and it happens only here.
 */
async function syncApprovedTitle(episodeId: string): Promise<void> {
  const [approved] = await db
    .select()
    .from(episodeContentDrafts)
    .where(
      and(
        eq(episodeContentDrafts.episodeId, episodeId),
        eq(episodeContentDrafts.field, "primary_headline"),
        eq(episodeContentDrafts.state, "APPROVED"),
      ),
    )
    .orderBy(asc(episodeContentDrafts.createdAt))
    .limit(1);

  await db
    .update(episodes)
    .set({ approvedTitle: approved?.value ?? null, updatedAt: new Date() })
    .where(eq(episodes.id, episodeId));
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
