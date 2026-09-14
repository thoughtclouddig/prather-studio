/**
 * Linking and updating a real Buzzsprout episode.
 *
 * Mirrors the YouTube publish path deliberately — same read-modify-write, same
 * fingerprint confirmation, same refusal to ship unapproved copy — because the
 * operator should not have to learn two different safety models. But the
 * differences between the two providers are real and are handled, not assumed
 * away:
 *
 *  1. NO DELETE. Buzzsprout documents GET, POST and PUT for episodes and
 *     nothing else. A wrongly created episode cannot be cleanly removed, which
 *     is why `createEpisode` refuses to run without audio and why linking
 *     always requires a human.
 *
 *  2. UPDATE SEMANTICS ARE UNDOCUMENTED. YouTube's videos.update is known to
 *     clear omitted properties. Buzzsprout says PUT returns the updated
 *     episode, but does not say whether omitted fields survive. So every write
 *     merges onto the CURRENT remote state — correct under either reading, and
 *     the cost of guessing wrong is a real episode losing its show notes.
 *
 *  3. COMPOSITION DIFFERS. A podcast player shows show notes, not a YouTube
 *     chapter strip, so the platform's own composition options are used rather
 *     than reusing YouTube's output verbatim.
 */
import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  episodeContentDrafts,
  episodePublications,
  episodes,
  standingBlocks,
  type EpisodePublication,
  type User,
} from "@/db/schema";
import { authorize } from "@/lib/auth/authorize";
import { recordActivity, type Actor } from "@/lib/domain/activity";
import {
  composeDescription,
  compositionOptionsFor,
  selectApprovedEditorial,
} from "@/lib/domain/composition";
import {
  getEpisode,
  updateEpisode,
  type BuzzsproutEpisode,
} from "@/lib/integrations/buzzsprout/client";

const actorFor = (user: User): Actor => ({ kind: "user", id: user.id, name: user.name });

/* --------------------------------------------------------------- linking */

export class BuzzsproutAlreadyLinkedError extends Error {
  constructor(externalId: string) {
    super(
      `This episode is already linked to Buzzsprout episode ${externalId}. ` +
        "Unlink it first if the link is wrong.",
    );
    this.name = "BuzzsproutAlreadyLinkedError";
  }
}

/**
 * Attach a canonical Episode to a real Buzzsprout episode.
 *
 * Always human-confirmed. The matcher produces a suggestion; this records a
 * decision. Attaching the wrong podcast entry is silent and would later
 * overwrite a real episode with another show's metadata.
 */
export async function linkBuzzsproutEpisode(
  user: User,
  episodeId: string,
  buzzsproutId: number,
): Promise<EpisodePublication> {
  authorize(user.role, "publication.enqueue");

  const [existing] = await db
    .select()
    .from(episodePublications)
    .where(
      and(
        eq(episodePublications.episodeId, episodeId),
        eq(episodePublications.platform, "BUZZSPROUT"),
      ),
    )
    .limit(1);

  if (existing?.externalId && existing.externalId !== String(buzzsproutId)) {
    throw new BuzzsproutAlreadyLinkedError(existing.externalId);
  }

  const remote = await getEpisode(buzzsproutId);
  if (!remote) {
    throw new Error(`Buzzsprout episode ${buzzsproutId} could not be read back.`);
  }

  const now = new Date();
  const [saved] = await db
    .update(episodePublications)
    .set({
      externalId: String(remote.id),
      externalUrl: remote.audioUrl,
      state: remote.private ? "SCHEDULED" : "PUBLISHED",
      publishedAt: remote.publishedAt ? new Date(remote.publishedAt) : null,
      remoteSnapshot: snapshotOf(remote) as never,
      remoteSnapshotAt: now,
      lastSyncAt: now,
      errorMessage: null,
      updatedAt: now,
    })
    .where(eq(episodePublications.id, existing!.id))
    .returning();

  await recordActivity({
    actor: actorFor(user),
    verb: "buzzsprout.linked",
    subjectType: "publication",
    subjectId: existing!.id,
    episodeId,
    summary:
      `Linked to Buzzsprout episode ${remote.id} — "${remote.title}" ` +
      `(${remote.durationSeconds ?? "?"}s, published ${remote.publishedAt ?? "unpublished"})`,
    after: { buzzsproutId: remote.id, title: remote.title, private: remote.private },
  });

  return saved!;
}

export async function unlinkBuzzsproutEpisode(
  user: User,
  episodeId: string,
): Promise<void> {
  authorize(user.role, "publication.enqueue");
  const [publication] = await db
    .select()
    .from(episodePublications)
    .where(
      and(
        eq(episodePublications.episodeId, episodeId),
        eq(episodePublications.platform, "BUZZSPROUT"),
      ),
    )
    .limit(1);
  if (!publication?.externalId) return;

  await db
    .update(episodePublications)
    .set({
      externalId: null,
      externalUrl: null,
      state: "NOT_STARTED",
      publishedAt: null,
      remoteSnapshot: null,
      remoteSnapshotAt: null,
      updatedAt: new Date(),
    })
    .where(eq(episodePublications.id, publication.id));

  await recordActivity({
    actor: actorFor(user),
    verb: "buzzsprout.unlinked",
    subjectType: "publication",
    subjectId: publication.id,
    episodeId,
    summary: `Unlinked Buzzsprout episode ${publication.externalId}. Nothing on Buzzsprout was changed.`,
    before: { buzzsproutId: publication.externalId },
  });
}

/* ------------------------------------------------------------- snapshot */

export interface BuzzsproutSnapshot {
  id: number;
  title: string;
  description: string | null;
  summary: string | null;
  publishedAt: string | null;
  private: boolean;
  durationSeconds: number | null;
  totalPlays: number | null;
}

export function snapshotOf(episode: BuzzsproutEpisode): BuzzsproutSnapshot {
  return {
    id: episode.id,
    title: episode.title,
    description: episode.description,
    summary: episode.summary,
    publishedAt: episode.publishedAt,
    private: episode.private,
    durationSeconds: episode.durationSeconds,
    totalPlays: episode.totalPlays,
  };
}

export function fingerprint(episode: BuzzsproutEpisode): string {
  return createHash("sha256")
    .update(`${episode.id} ${episode.title} ${episode.description ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

/* ----------------------------------------------------------------- plan */

export interface BuzzsproutFieldChange {
  field: "title" | "description";
  current: string;
  proposed: string;
  changed: boolean;
}

export interface BuzzsproutUpdatePlan {
  buzzsproutId: number;
  remote: BuzzsproutEpisode;
  changes: BuzzsproutFieldChange[];
  hasChanges: boolean;
  /** The composed description, with its sections, for the review preview. */
  composition: ReturnType<typeof composeDescription>;
  missing: string[];
  remoteDrift: { since: Date | null; fields: string[] } | null;
  remoteFingerprint: string;
}

export async function planBuzzsproutUpdate(
  episodeId: string,
): Promise<BuzzsproutUpdatePlan> {
  const [publication] = await db
    .select()
    .from(episodePublications)
    .where(
      and(
        eq(episodePublications.episodeId, episodeId),
        eq(episodePublications.platform, "BUZZSPROUT"),
      ),
    )
    .limit(1);

  const externalId = publication?.externalId;
  if (!externalId) {
    throw new Error("This episode is not linked to a Buzzsprout episode yet.");
  }

  const remote = await getEpisode(Number(externalId));
  if (!remote) {
    throw new Error(`Buzzsprout episode ${externalId} is no longer reachable.`);
  }

  const [episode] = await db
    .select()
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1);

  const drafts = await db
    .select()
    .from(episodeContentDrafts)
    .where(eq(episodeContentDrafts.episodeId, episodeId))
    .orderBy(asc(episodeContentDrafts.sortOrder), asc(episodeContentDrafts.createdAt));

  const blocks = episode
    ? await db
        .select()
        .from(standingBlocks)
        .where(eq(standingBlocks.showId, episode.showId))
        .orderBy(asc(standingBlocks.sortOrder))
    : [];

  const approved = selectApprovedEditorial(drafts, "BUZZSPROUT");
  const composition = composeDescription({
    editorial: approved.editorial,
    chapters: approved.chapters,
    standingBlocks: blocks,
    platform: "BUZZSPROUT",
    ...compositionOptionsFor("BUZZSPROUT"),
  });

  const missing: string[] = [];
  if (!approved.title) missing.push("an approved title");
  if (!approved.editorial) missing.push("approved Buzzsprout show notes");

  const changes: BuzzsproutFieldChange[] = [
    {
      field: "title",
      current: remote.title,
      proposed: approved.title ?? remote.title,
      changed: !!approved.title && approved.title !== remote.title,
    },
    {
      field: "description",
      current: remote.description ?? "",
      proposed: composition.text || (remote.description ?? ""),
      changed: !!composition.text && composition.text !== (remote.description ?? ""),
    },
  ];

  const previous = publication.remoteSnapshot as BuzzsproutSnapshot | null;
  const drifted: string[] = [];
  if (previous) {
    if (previous.title !== remote.title) drifted.push("title");
    if ((previous.description ?? "") !== (remote.description ?? "")) {
      drifted.push("description");
    }
  }

  return {
    buzzsproutId: remote.id,
    remote,
    changes,
    hasChanges: changes.some((c) => c.changed),
    composition,
    missing,
    remoteDrift:
      drifted.length > 0 ? { since: publication.remoteSnapshotAt, fields: drifted } : null,
    remoteFingerprint: fingerprint(remote),
  };
}

/* ---------------------------------------------------------------- apply */

export class BuzzsproutRemoteChangedError extends Error {
  constructor(readonly fields: string[]) {
    super(
      `The Buzzsprout episode changed since you opened this diff (${fields.join(", ")}). ` +
        "Re-open the update so you can see the newer remote state before overwriting it.",
    );
    this.name = "BuzzsproutRemoteChangedError";
  }
}

export async function applyBuzzsproutUpdate(
  user: User,
  episodeId: string,
  confirmedFingerprint: string,
  opts: { acknowledgeDrift?: boolean } = {},
): Promise<{ publication: EpisodePublication; remote: BuzzsproutEpisode }> {
  authorize(user.role, "publication.enqueue");

  const plan = await planBuzzsproutUpdate(episodeId);
  if (plan.missing.length > 0) {
    throw new Error(
      `Nothing can be sent to Buzzsprout yet. Still needs ${plan.missing.join(" and ")}.`,
    );
  }
  if (!plan.hasChanges) {
    throw new Error("Buzzsprout already matches the approved metadata. Nothing to send.");
  }
  if (plan.remoteFingerprint !== confirmedFingerprint) {
    throw new BuzzsproutRemoteChangedError(["title or description"]);
  }
  if (plan.remoteDrift && !opts.acknowledgeDrift) {
    throw new BuzzsproutRemoteChangedError(plan.remoteDrift.fields);
  }

  const [publication] = await db
    .select()
    .from(episodePublications)
    .where(
      and(
        eq(episodePublications.episodeId, episodeId),
        eq(episodePublications.platform, "BUZZSPROUT"),
      ),
    )
    .limit(1);

  const before = snapshotOf(plan.remote);
  await recordActivity({
    actor: actorFor(user),
    verb: "buzzsprout.metadata_snapshot",
    subjectType: "publication",
    subjectId: publication!.id,
    episodeId,
    summary: `Captured Buzzsprout metadata for episode ${plan.buzzsproutId} before updating it`,
    before,
  });

  const titleChange = plan.changes.find((c) => c.field === "title")!;
  const descriptionChange = plan.changes.find((c) => c.field === "description")!;

  try {
    // Merged onto the current remote state — see the note at the top of this
    // file about undocumented PUT semantics.
    const updated = await updateEpisode(plan.buzzsproutId, plan.remote, {
      title: titleChange.proposed,
      description: descriptionChange.proposed,
    });

    const now = new Date();
    const [saved] = await db
      .update(episodePublications)
      .set({
        state: updated.private ? "SCHEDULED" : "PUBLISHED",
        lastSyncAt: now,
        remoteSnapshot: snapshotOf(updated) as never,
        remoteSnapshotAt: now,
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(episodePublications.id, publication!.id))
      .returning();

    await recordActivity({
      actor: actorFor(user),
      verb: "buzzsprout.metadata_updated",
      subjectType: "publication",
      subjectId: publication!.id,
      episodeId,
      summary:
        `Updated Buzzsprout episode ${plan.buzzsproutId}: ` +
        plan.changes.filter((c) => c.changed).map((c) => c.field).join(" and "),
      before: { title: before.title, description: before.description },
      after: { title: updated.title, description: updated.description },
    });

    return { publication: saved!, remote: updated };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(episodePublications)
      .set({ state: "FAILED", errorMessage: message.slice(0, 1000), updatedAt: new Date() })
      .where(eq(episodePublications.id, publication!.id));

    await recordActivity({
      actor: actorFor(user),
      verb: "buzzsprout.metadata_failed",
      subjectType: "publication",
      subjectId: publication!.id,
      episodeId,
      summary: `Buzzsprout update failed for episode ${plan.buzzsproutId}: ${message}`,
      after: { error: message },
    });
    throw error;
  }
}
