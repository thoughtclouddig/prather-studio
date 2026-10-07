"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/require";
import {
  approveDraft,
  editAndApproveDraft,
  rejectDraft,
} from "@/lib/domain/drafts";
import {
  enqueueSimulatedPublish,
  setPublicationIntent,
} from "@/lib/domain/publications";
import { deleteEpisode, updateEpisode } from "@/lib/domain/episodes";
import { enqueue, retry } from "@/lib/queue/queue";
import { DiagnosticsDisabledError, diagnosticsEnabled } from "@/lib/diagnostics";
import { fromShowInputValue } from "@/lib/format";
import type { EpisodePhase, PublicationIntent, Readiness } from "@/db/schema";

/** Server actions return this shape so forms can show a real error instead of
 *  a blank screen when authorization or a domain invariant rejects them. */
export type ActionState = { error?: string; ok?: string } | undefined;

async function guarded(
  fn: () => Promise<string | void>,
  paths: string[],
): Promise<ActionState> {
  try {
    const ok = await fn();
    for (const p of paths) revalidatePath(p, "page");
    return ok ? { ok } : {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const episodePaths = (id: string) => [
  "/studio",
  "/studio/episodes",
  `/studio/episodes/${id}`,
  `/studio/episodes/${id}/review`,
  "/studio/jobs",
];

/* --------------------------------------------------------------- drafts */

export async function approveDraftAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const draftId = String(formData.get("draftId"));
  const episodeId = String(formData.get("episodeId"));
  return guarded(async () => {
    const user = await requirePermission("draft.approve");
    await approveDraft(user, draftId);
  }, episodePaths(episodeId));
}

export async function rejectDraftAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const draftId = String(formData.get("draftId"));
  const episodeId = String(formData.get("episodeId"));
  return guarded(async () => {
    const user = await requirePermission("draft.reject");
    await rejectDraft(user, draftId);
  }, episodePaths(episodeId));
}

export async function editApproveDraftAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const draftId = String(formData.get("draftId"));
  const episodeId = String(formData.get("episodeId"));
  const value = String(formData.get("value") ?? "");
  return guarded(async () => {
    const user = await requirePermission("draft.edit");
    await editAndApproveDraft(user, draftId, value);
  }, episodePaths(episodeId));
}

/* --------------------------------------------------------- publications */

export async function setIntentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const publicationId = String(formData.get("publicationId"));
  const episodeId = String(formData.get("episodeId"));
  const intent = String(formData.get("intent")) as PublicationIntent;
  return guarded(async () => {
    const user = await requirePermission("publication.intent");
    await setPublicationIntent(user, publicationId, intent);
  }, episodePaths(episodeId));
}

/** SIMULATE QUEUE — enqueues a simulation job. Contacts no platform. */
export async function simulateQueueAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const publicationId = String(formData.get("publicationId"));
  const episodeId = String(formData.get("episodeId"));
  return guarded(async () => {
    const user = await requirePermission("publication.enqueue");
    await enqueueSimulatedPublish(user, publicationId);
    return "Simulation job queued — the worker will pick it up.";
  }, episodePaths(episodeId));
}

/* -------------------------------------------------------------- episode */

export async function updateEpisodeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  const scheduledRaw = String(formData.get("scheduledAt") ?? "").trim();
  return guarded(async () => {
    const user = await requirePermission("episode.edit");
    await updateEpisode(user, episodeId, {
      workingTitle: String(formData.get("workingTitle") ?? "").trim(),
      phase: String(formData.get("phase")) as EpisodePhase,
      showPrepState: String(formData.get("showPrepState")) as Readiness,
      artworkState: String(formData.get("artworkState")) as Readiness,
      internalNotes: String(formData.get("internalNotes") ?? "").trim() || null,
      // The input is in SHOW time (ET), not browser time — an operator in
      // Phoenix must not shift a 2:00 PM ET slot by editing an unrelated field.
      scheduledAt: fromShowInputValue(scheduledRaw),
    });
    return "Episode saved.";
  }, episodePaths(episodeId));
}

/* ----------------------------------------------------------------- jobs */

export async function retryJobAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const jobId = String(formData.get("jobId"));
  return guarded(async () => {
    const user = await requirePermission("job.retry");
    await retry(jobId, { kind: "user", id: user.id, name: user.name });
    return "Job requeued.";
  }, ["/studio/jobs", "/studio"]);
}

/** Diagnostics: enqueue one of the two test handlers so the full job
 *  lifecycle can be watched live. Not a provider call. */
export async function enqueueTestJobAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const kind = String(formData.get("kind"));
  if (kind !== "ping" && kind !== "fail-test") {
    return { error: "Only the ping and fail-test handlers can be run manually." };
  }
  // Refused on the server, not merely hidden in the UI — a hidden button is a
  // presentation choice, and this needs to be a rule.
  if (!diagnosticsEnabled()) {
    return { error: new DiagnosticsDisabledError(kind).message };
  }
  return guarded(async () => {
    const user = await requirePermission("job.retry");
    await enqueue({
      kind,
      idempotencyKey: `manual:${kind}:${Date.now()}`,
      maxAttempts: 3,
      actor: { kind: "user", id: user.id, name: user.name },
    });
    return `Queued a ${kind} job.`;
  }, ["/studio/jobs"]);
}

/**
 * Delete an episode.
 *
 * OWNER only, and the confirmation names what goes with it — the cascade
 * reaches the drafts, the transcript, the publication links, the artwork and
 * the job history, and "delete this episode" does not look like it means "and
 * the transcript that took four hours to arrive".
 *
 * Redirects to the archive afterwards, because the page the operator is
 * standing on is the one that just stopped existing.
 */
export async function deleteEpisodeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  const force = formData.get("force") === "on";

  let deleted: { title: string } | null = null;
  const result = await guarded(async () => {
    const user = await requirePermission("episode.delete");
    deleted = await deleteEpisode(
      episodeId,
      { kind: "user", id: user.id, name: user.name },
      { force },
    );
    return `Deleted "${deleted.title}".`;
  }, ["/studio", "/studio/episodes"]);

  // Only leave the page once the delete actually happened; an error has to
  // stay on screen where it can be read.
  if (deleted) redirect("/studio/episodes");
  return result;
}
