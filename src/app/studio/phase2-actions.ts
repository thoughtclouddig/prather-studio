"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission, requireUser } from "@/lib/auth/require";
import { createEpisode } from "@/lib/domain/create-episode";
import {
  candidatesForEpisode,
  linkYouTubeVideo,
  unlinkYouTubeVideo,
} from "@/lib/domain/linkage";
import { applyYouTubeUpdate, buildApprovedMetadata } from "@/lib/domain/youtube-publish";
import { composePostBody, resolveRumbleEmbed } from "@/lib/domain/wordpress-post";
import { slugFor } from "@/lib/images/thumbnail-brief";
import { disconnect, saveCredential } from "@/lib/integrations/credentials";
import {
  createDraftEpisode,
  verifyToken,
} from "@/lib/integrations/buzzsprout/client";
import {
  createDraftPost,
  normalizeSiteUrl,
  uploadMedia,
  verifyCredentials,
} from "@/lib/integrations/wordpress/client";
import { testConnection } from "@/lib/integrations/rumble/observer";
import {
  datacenterFromKey,
  verifyKey,
} from "@/lib/integrations/mailchimp/client";
import { normalizeRumbleInput } from "@/lib/integrations/rumble/credential-input";
import { listStores } from "@/lib/integrations/printful/client";
import {
  listRecentVideos,
  listUpcomingBroadcasts,
  setThumbnail,
} from "@/lib/integrations/youtube/client";
import { PROMPT_VERSION } from "@/lib/content/package";
import { PRE_SHOW_PROMPT_VERSION } from "@/lib/content/pre-show";
import { scheduleBriefingCampaign } from "@/lib/domain/briefing-campaign";
import { recordActivity } from "@/lib/domain/activity";
import { enqueue } from "@/lib/queue/queue";
import { fromShowInputValue } from "@/lib/format";
import { extractVideoId } from "@/lib/integrations/youtube/video-id";
import { db } from "@/db/client";
import { episodes, type IntegrationProvider, episodeTranscripts, episodeContentDrafts, episodeImages, episodePublications} from "@/db/schema";
import { and, desc, eq, ne } from "drizzle-orm";
import type { ActionState } from "./actions";

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

/* ------------------------------------------------------------- episodes */

export async function createEpisodeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requirePermission("episode.create");

  const workingTitle = String(formData.get("workingTitle") ?? "").trim();
  const scheduledRaw = String(formData.get("scheduledAt") ?? "").trim();
  const numberRaw = String(formData.get("episodeNumber") ?? "").trim();
  const notes = String(formData.get("internalNotes") ?? "").trim();

  let episodeId: string;
  try {
    const episode = await createEpisode(user, {
      workingTitle,
      scheduledAt: fromShowInputValue(scheduledRaw),
      episodeNumber: numberRaw ? Number(numberRaw) : null,
      internalNotes: notes || null,
    });
    episodeId = episode.id;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  revalidatePath("/studio", "page");
  revalidatePath("/studio/episodes", "page");
  redirect(`/studio/episodes/${episodeId}`);
}

/* -------------------------------------------------------- YouTube link */

export async function linkYouTubeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  const raw = String(formData.get("videoId") ?? "").trim();
  const via = String(formData.get("via") ?? "manual") as "manual" | "candidate";

  return guarded(async () => {
    const user = await requirePermission("publication.intent");
    const videoId = extractVideoId(raw);
    if (!videoId) {
      throw new Error(
        "That does not look like a YouTube video ID or URL. Expected an 11-character ID.",
      );
    }
    const { video } = await linkYouTubeVideo(user, episodeId, videoId, { via });
    return `Linked to "${video.title}".`;
  }, episodePaths(episodeId));
}

export async function unlinkYouTubeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  return guarded(async () => {
    const user = await requirePermission("publication.intent");
    await unlinkYouTubeVideo(user, episodeId);
    return "Unlinked from YouTube.";
  }, episodePaths(episodeId));
}

/** Live candidate lookup. Two quota units, and the operator is waiting. */
export async function loadCandidates(episodeId: string) {
  await requireUser();
  const [episode] = await db
    .select()
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1);
  if (!episode) throw new Error("Episode not found");

  // Uploads AND scheduled broadcasts. A stream StreamYard has scheduled is not
  // in the uploads playlist until it airs, so without the second call an
  // episode could not be linked — and its thumbnail could not be set — until
  // the show was already running. Which is exactly too late.
  const [uploads, upcoming] = await Promise.all([
    listRecentVideos(25),
    listUpcomingBroadcasts(10).catch(() => []),
  ]);

  // Upcoming first: when a broadcast appears in both, the live record is the
  // one carrying the scheduled start time the matcher keys on.
  const seen = new Set<string>();
  const videos = [...upcoming, ...uploads].filter((v) =>
    seen.has(v.id) ? false : (seen.add(v.id), true),
  );

  return candidatesForEpisode(episode, videos);
}

/* ------------------------------------------------------------ pipeline */

export async function enqueueCaptionsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  return guarded(async () => {
    const user = await requirePermission("publication.enqueue");
    await enqueue({
      kind: "youtube.fetch_captions",
      idempotencyKey: `youtube.fetch_captions:${episodeId}:${Date.now()}`,
      episodeId,
      maxAttempts: 3,
      actor: { kind: "user", id: user.id, name: user.name },
    });
    return "Queued caption retrieval. It will package the episode automatically if it succeeds.";
  }, episodePaths(episodeId));
}

export async function enqueuePackageAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  return guarded(async () => {
    const user = await requirePermission("publication.enqueue");

    // The key must match the one the transcript chain uses, or the two paths
    // cannot deduplicate against each other. It used to carry Date.now(),
    // which made every click unique by construction -- so pressing the button
    // on an episode whose transcript had already triggered packaging produced
    // a SECOND full set of drafts, and the review screen showed two of every
    // field with no way to tell which was which.
    const [transcript] = await db
      .select({ id: episodeTranscripts.id })
      .from(episodeTranscripts)
      .where(eq(episodeTranscripts.episodeId, episodeId))
      .orderBy(desc(episodeTranscripts.createdAt))
      .limit(1);

    if (!transcript) {
      throw new Error(
        "There is no transcript to package yet. Retrieve the transcript first.",
      );
    }

    await enqueue({
      kind: "episode.package",
      idempotencyKey: `episode.package:${episodeId}:${transcript.id}:${PROMPT_VERSION}`,
      episodeId,
      maxAttempts: 2,
      actor: { kind: "user", id: user.id, name: user.name },
    });
    return "Queued the content engine. Proposals will appear in Review.";
  }, episodePaths(episodeId));
}

/**
 * Discard every draft for an episode and generate a fresh package.
 *
 * Exists for one situation, which actually happened: two packaging runs left
 * two live sets of every field and an operator approved across both of them.
 * The ordinary re-run only retires PROPOSED drafts — an APPROVED draft is a
 * human decision and is never discarded by a machine — so there was no way out
 * of that state from the interface at all.
 *
 * This is the explicit, operator-initiated way out. It is deliberately
 * separate from RUN CONTENT ENGINE and deliberately destructive: it supersedes
 * APPROVED drafts too, and clears the episode's approved title, because
 * leaving a title behind that no longer has a draft supporting it is exactly
 * the kind of orphaned state that is hard to reason about later.
 *
 * Nothing is deleted. SUPERSEDED drafts remain as history.
 */
export async function regenerateContentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  return guarded(async () => {
    const user = await requirePermission("publication.enqueue");

    const [transcript] = await db
      .select({ id: episodeTranscripts.id })
      .from(episodeTranscripts)
      .where(eq(episodeTranscripts.episodeId, episodeId))
      .orderBy(desc(episodeTranscripts.createdAt))
      .limit(1);

    if (!transcript) {
      throw new Error("There is no transcript to package. Retrieve it first.");
    }

    const cleared = await db
      .update(episodeContentDrafts)
      .set({ state: "SUPERSEDED" })
      .where(
        and(
          eq(episodeContentDrafts.episodeId, episodeId),
          ne(episodeContentDrafts.state, "SUPERSEDED"),
        ),
      )
      .returning({ id: episodeContentDrafts.id });

    // The approved title came from a draft that no longer stands.
    await db
      .update(episodes)
      .set({ approvedTitle: null, updatedAt: new Date() })
      .where(eq(episodes.id, episodeId));

    await recordActivity({
      actor: { kind: "user", id: user.id, name: user.name },
      verb: "episode.content_cleared",
      subjectType: "episode",
      subjectId: episodeId,
      episodeId,
      summary: `Cleared ${cleared.length} draft(s) and queued a fresh package`,
    });

    // The deterministic key would be a no-op here, because the identical job
    // already succeeded. A regeneration is a genuinely new request, so it
    // carries a counter — which is also what makes it auditable.
    await enqueue({
      kind: "episode.package",
      idempotencyKey:
        `episode.package:${episodeId}:${transcript.id}:${PROMPT_VERSION}:regen:${Date.now()}`,
      episodeId,
      maxAttempts: 2,
      actor: { kind: "user", id: user.id, name: user.name },
    });

    return `Cleared ${cleared.length} draft(s). A fresh package is queued.`;
  }, episodePaths(episodeId));
}

/**
 * Prepare the email from Jeff's submission, before the show.
 *
 * Keyed on the submission time and the prompt version, so pressing it twice on
 * an unchanged submission is a no-op — but a resubmission from Jeff produces a
 * genuinely new key and regenerates, which is the behaviour an operator
 * expects after he sends a correction.
 */
/**
 * Schedule the briefing campaign in Mailchimp.
 *
 * The one action in the Studio that reaches an audience without a second
 * human step afterwards, so it is deliberately narrow: it schedules, it never
 * sends, and everything it refuses it refuses loudly. The send time comes from
 * Settings (11:00 America/Phoenix by default), not from this form — an
 * operator choosing a one-off time in a hurry is how a briefing goes out at
 * an hour nobody meant.
 */
export async function scheduleBriefingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  return guarded(async () => {
    const user = await requirePermission("publication.enqueue");
    const result = await scheduleBriefingCampaign(episodeId, user);
    return `Scheduled in Mailchimp for ${result.sendSummary}. It is a draft until then — nothing has been sent.`;
  }, episodePaths(episodeId));
}

export async function runPreShowAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  return guarded(async () => {
    const user = await requirePermission("publication.enqueue");

    const [episode] = await db
      .select({ submittedAt: episodes.submittedAt, headline: episodes.hostHeadline })
      .from(episodes)
      .where(eq(episodes.id, episodeId))
      .limit(1);

    if (!episode?.headline) {
      throw new Error("Jeff has not submitted this show yet, so there is nothing to prepare.");
    }

    await enqueue({
      kind: "episode.pre_show",
      idempotencyKey:
        `episode.pre_show:${episodeId}:${episode.submittedAt?.getTime() ?? 0}:${PRE_SHOW_PROMPT_VERSION}`,
      episodeId,
      maxAttempts: 2,
      actor: { kind: "user", id: user.id, name: user.name },
    });

    return "Preparing the email from Jeff's submission. It will appear in Review.";
  }, episodePaths(episodeId));
}

/* ------------------------------------------------------------ Mailchimp */

/* ------------------------------------------------------------- Printful */

/**
 * Connect the merch store.
 *
 * The verification deliberately reports what Printful DOES and DOES NOT know.
 * A store that cannot tell us its own website is a store whose products have
 * no linkable address, and the operator should learn that here rather than
 * from a briefing full of dead links.
 */
export async function connectPrintfulAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const token = String(formData.get("token") ?? "").trim();
  const requestedStore = String(formData.get("storeId") ?? "").trim();
  const website = String(formData.get("website") ?? "").trim();

  return guarded(async () => {
    const user = await requirePermission("integration.configure");
    if (!token) throw new Error("Paste the Printful API token.");

    const stores = await listStores(token, requestedStore || null);
    if (stores.length === 0) {
      throw new Error("That token is valid but reaches no Printful store.");
    }

    const chosen = requestedStore
      ? stores.find((s) => String(s.id) === requestedStore)
      : stores.length === 1
        ? stores[0]
        : undefined;

    if (!chosen) {
      throw new Error(
        `This token reaches ${stores.length} stores (` +
          stores.map((s) => `${s.id} ${s.name}`).join(", ") +
          "). Enter the store ID to say which one.",
      );
    }

    // An operator-supplied address wins: Printful often does not store one,
    // and it is the only thing that makes a product linkable.
    const resolved = website || chosen.website;

    await saveCredential({
      provider: "PRINTFUL",
      kind: "API_KEY",
      payload: {
        token,
        storeId: String(chosen.id),
        website: resolved ?? null,
        storeType: chosen.type,
      },
      accountLabel: `${chosen.name}${chosen.type ? ` · ${chosen.type}` : ""}`,
      accountExternalId: String(chosen.id),
      actor: { kind: "user", id: user.id, name: user.name },
      connectedBy: user.id,
    });

    return resolved
      ? `Connected to "${chosen.name}". Shop address: ${resolved}`
      : `Connected to "${chosen.name}", but Printful does not know the shop's web ` +
          `address — add it above so products can be linked from the email.`;
  }, ["/studio/integrations", "/studio"]);
}

export async function connectMailchimpAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const requestedList = String(formData.get("listId") ?? "").trim();

  return guarded(async () => {
    const user = await requirePermission("integration.configure");
    if (!apiKey) throw new Error("Paste the Mailchimp API key.");

    const account = await verifyKey(apiKey);
    if (account.audiences.length === 0) {
      throw new Error("That key is valid but reaches no audiences.");
    }

    // An operator picks from the list rather than pasting an id. A wrong list
    // id is a briefing sent to the wrong people, and Mailchimp will not say it
    // was wrong — only that it worked.
    const chosen = requestedList
      ? account.audiences.find((a) => a.id === requestedList)
      : account.audiences.length === 1
        ? account.audiences[0]
        : account.audiences.find((a) => a.id === "6f7bc677e9");

    if (!chosen) {
      throw new Error(
        `This key reaches ${account.audiences.length} audiences (` +
          account.audiences.map((a) => `${a.id} ${a.name}`).join(", ") +
          "). Enter the audience ID to say which one.",
      );
    }

    await saveCredential({
      provider: "MAILCHIMP",
      kind: "API_KEY",
      payload: { apiKey, listId: chosen.id, datacenter: datacenterFromKey(apiKey)! },
      accountLabel: `${account.accountName} · ${chosen.name}`,
      accountExternalId: chosen.id,
      actor: { kind: "user", id: user.id, name: user.name },
      connectedBy: user.id,
    });

    return `Connected to "${chosen.name}" (${chosen.memberCount.toLocaleString()} subscribers).`;
  }, ["/studio/integrations", "/studio"]);
}

/* --------------------------------------------- Buzzsprout & WordPress */

/** The square thumbnail, if one has been accepted. Used in three places. */
async function squareThumbnail(episodeId: string) {
  const [image] = await db
    .select()
    .from(episodeImages)
    .where(
      and(
        eq(episodeImages.episodeId, episodeId),
        eq(episodeImages.kind, "THUMBNAIL_1_1"),
        eq(episodeImages.state, "ACCEPTED"),
      ),
    )
    .limit(1);
  return image ?? null;
}

/**
 * Create the Buzzsprout episode as a private draft, with artwork, before the
 * audio exists.
 *
 * The show notes can be written, reviewed and approved well before a recording
 * is exported. Requiring audio first inverted the order the work actually
 * happens in, and left the podcast as the last thing done on a show day rather
 * than something already waiting.
 *
 * Private is Buzzsprout's draft state, and since Buzzsprout documents no
 * DELETE, private is also the only kind of mistake that can be walked back.
 */
export async function createBuzzsproutDraftAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  return guarded(async () => {
    const user = await requirePermission("publication.enqueue");

    const [episode] = await db
      .select()
      .from(episodes)
      .where(eq(episodes.id, episodeId))
      .limit(1);
    if (!episode) throw new Error("Episode not found.");

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

    if (publication?.externalId) {
      throw new Error(
        `This episode is already linked to Buzzsprout episode ${publication.externalId}.`,
      );
    }

    const approved = await buildApprovedMetadata(episodeId);
    const title = approved.title ?? episode.approvedTitle;
    if (!title) {
      throw new Error("Approve a headline first — the draft carries it to Buzzsprout.");
    }

    const square = await squareThumbnail(episodeId);

    const created = await createDraftEpisode({
      title,
      description: approved.composedDescription ?? undefined,
      episodeNumber: episode.episodeNumber,
      artwork: square
        ? {
            bytes: square.bytes,
            contentType: square.contentType,
            filename: "artwork.jpg",
          }
        : null,
    });

    const now = new Date();
    await db
      .update(episodePublications)
      .set({
        externalId: String(created.id),
        externalUrl: created.audioUrl,
        state: "SCHEDULED",
        lastSyncAt: now,
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(episodePublications.id, publication!.id));

    await recordActivity({
      actor: { kind: "user", id: user.id, name: user.name },
      verb: "buzzsprout.draft_created",
      subjectType: "publication",
      subjectId: publication!.id,
      episodeId,
      summary:
        `Created Buzzsprout episode ${created.id} as a PRIVATE draft` +
        (square ? " with the square artwork" : " (no artwork yet)") +
        ". Audio and publishing are still outstanding.",
      after: { buzzsproutId: created.id, hadArtwork: !!square },
    });

    return (
      `Created Buzzsprout episode ${created.id} as a private draft` +
      (square ? " with artwork." : ". Upload the square thumbnail to add artwork.")
    );
  }, episodePaths(episodeId));
}

/**
 * Create the episode post on jeffreyprather.com, as a draft.
 *
 * The 1:1 thumbnail becomes the featured image — the operator's choice, and the
 * right one, since the square survives the theme's cropping at every size.
 *
 * The Rumble URL is supplied by the operator because Rumble exposes no VOD
 * listing; it is resolved through oEmbed rather than turned into an iframe by
 * hand, since the page slug and the embed id are different strings and building
 * the player from the page URL yields an embed that plays nothing.
 */
export async function createWordPressDraftAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  const rumbleUrl = String(formData.get("rumbleUrl") ?? "").trim();

  return guarded(async () => {
    const user = await requirePermission("publication.enqueue");

    const [episode] = await db
      .select()
      .from(episodes)
      .where(eq(episodes.id, episodeId))
      .limit(1);
    if (!episode) throw new Error("Episode not found.");

    const approved = await buildApprovedMetadata(episodeId);
    const title = approved.title ?? episode.approvedTitle;
    if (!title) {
      throw new Error("Approve a headline first — it becomes the post title.");
    }

    const embed = rumbleUrl ? await resolveRumbleEmbed(rumbleUrl) : null;

    const [youtubePub] = await db
      .select()
      .from(episodePublications)
      .where(
        and(
          eq(episodePublications.episodeId, episodeId),
          eq(episodePublications.platform, "YOUTUBE"),
        ),
      )
      .limit(1);

    // Featured image first: a post created without it would need a second call
    // to attach one, and a failure there would leave a post with no artwork.
    const square = await squareThumbnail(episodeId);
    let featuredMediaId: number | undefined;
    if (square) {
      const uploaded = await uploadMedia(
        new Blob([new Uint8Array(square.bytes)], { type: square.contentType }),
        `${slugFor(title)}-1024x1024.jpg`,
        square.contentType,
      );
      featuredMediaId = uploaded.id;
    }

    const body = composePostBody({
      embedHtml: embed?.html ?? null,
      summary: approved.descriptionBody,
      chapters: approved.chapters,
      youtubeUrl: youtubePub?.externalUrl ?? null,
      podcastUrl: null,
      standingBlocks: null,
    });

    const post = await createDraftPost({
      title,
      content: body,
      slug: slugFor(title),
      ...(featuredMediaId ? { featuredMediaId } : {}),
    });

    const [publication] = await db
      .select()
      .from(episodePublications)
      .where(
        and(
          eq(episodePublications.episodeId, episodeId),
          eq(episodePublications.platform, "WORDPRESS"),
        ),
      )
      .limit(1);

    const now = new Date();
    if (publication) {
      await db
        .update(episodePublications)
        .set({
          externalId: String(post.id),
          externalUrl: post.link,
          state: "SCHEDULED",
          lastSyncAt: now,
          errorMessage: null,
          updatedAt: now,
        })
        .where(eq(episodePublications.id, publication.id));
    }

    await recordActivity({
      actor: { kind: "user", id: user.id, name: user.name },
      verb: "wordpress.draft_created",
      subjectType: "publication",
      subjectId: publication?.id,
      episodeId,
      summary:
        `Created WordPress draft post ${post.id}` +
        (featuredMediaId ? " with the square as featured image" : " (no featured image)") +
        (embed ? " and the Rumble embed" : " and no Rumble embed") +
        ". It is a DRAFT — publish it in WordPress.",
      after: { postId: post.id, link: post.link, featuredMediaId, rumbleUrl },
    });

    return `Created WordPress draft ${post.id}. It is a draft — publish it in WordPress.`;
  }, episodePaths(episodeId));
}

/* -------------------------------------------------------- YouTube write */

/**
 * Push the approved 16:9 thumbnail to the linked YouTube video.
 *
 * Separate from the metadata update on purpose. A thumbnail is a different
 * decision from a title and description — it is often ready later, and an
 * operator who is happy with the copy should not have to re-send it to change
 * the picture.
 *
 * YouTube's own limits are enforced on upload rather than here (1920x1080,
 * under 2 MB), so by the time an image is stored it is already acceptable.
 * What this checks is the thing storage cannot: that there IS a linked video.
 */
export async function pushThumbnailAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  return guarded(async () => {
    const user = await requirePermission("publication.enqueue");

    const [publication] = await db
      .select()
      .from(episodePublications)
      .where(
        and(
          eq(episodePublications.episodeId, episodeId),
          eq(episodePublications.platform, "YOUTUBE"),
        ),
      )
      .limit(1);

    const videoId = publication?.externalId;
    if (!videoId) {
      throw new Error("This episode is not linked to a YouTube video yet.");
    }

    const [image] = await db
      .select()
      .from(episodeImages)
      .where(
        and(
          eq(episodeImages.episodeId, episodeId),
          eq(episodeImages.kind, "THUMBNAIL_16_9"),
          eq(episodeImages.state, "ACCEPTED"),
        ),
      )
      .limit(1);

    if (!image) {
      throw new Error("Upload the 1920x1080 master first.");
    }

    await setThumbnail(videoId, image.bytes, image.contentType);

    await recordActivity({
      actor: { kind: "user", id: user.id, name: user.name },
      verb: "youtube.thumbnail_set",
      subjectType: "publication",
      subjectId: publication!.id,
      episodeId,
      summary:
        `Set the thumbnail on YouTube video ${videoId} ` +
        `(${image.width}x${image.height}, ${Math.round(image.byteSize / 1024)} KB)`,
      after: { videoId, imageId: image.id, bytes: image.byteSize },
    });

    return `Thumbnail set on ${videoId}.`;
  }, episodePaths(episodeId));
}


/**
 * Apply the metadata update.
 *
 * Runs synchronously on purpose: the fingerprint the operator confirmed must
 * be checked against the remote state with no queue delay in between.
 */
export async function applyYouTubeUpdateAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  const fingerprint = String(formData.get("fingerprint") ?? "");
  const acknowledgeDrift = formData.get("acknowledgeDrift") === "on";

  return guarded(async () => {
    const user = await requirePermission("publication.enqueue");
    const { video } = await applyYouTubeUpdate(user, episodeId, fingerprint, {
      acknowledgeDrift,
    });
    // Read back from YouTube, so success means "verified", not "no error".
    return `YouTube updated and verified. Title now reads "${video.title}".`;
  }, episodePaths(episodeId));
}

/* -------------------------------------------------------- integrations */

export async function connectRumbleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const entered = String(formData.get("apiUrl") ?? "").trim();
  return guarded(async () => {
    const user = await requirePermission("integration.configure");

    // Accept either the whole URL or just the key — Rumble encodes the user id
    // inside the key, so the URL reconstructs exactly. Refuse an RTMP ingest
    // URL by name: that is the encoder's destination, not a data source.
    const input = normalizeRumbleInput(entered);
    if (input.kind === "rtmp" || input.kind === "unknown") {
      throw new Error(input.reason);
    }
    const apiUrl = input.apiUrl;

    // Prove it works before storing it.
    const observation = await testConnection(apiUrl);
    await saveCredential({
      provider: "RUMBLE",
      kind: "URL_SECRET",
      payload: { apiUrl },
      accountLabel:
        observation.followersTotal !== null
          ? `${observation.followersTotal.toLocaleString()} followers`
          : "Live Stream API",
      actor: { kind: "user", id: user.id, name: user.name },
      connectedBy: user.id,
    });
    return observation.liveNow
      ? `Connected. Rumble is live right now: "${observation.liveNow.title}".`
      : "Connected. Rumble reports no stream live at the moment.";
  }, ["/studio/integrations", "/studio"]);
}

export async function disconnectIntegrationAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const provider = String(formData.get("provider")) as IntegrationProvider;
  return guarded(async () => {
    const user = await requirePermission("integration.configure");
    await disconnect(user, provider);
    return `${provider} disconnected.`;
  }, ["/studio/integrations", "/studio"]);
}

export async function testIntegrationsAction(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  return guarded(async () => {
    const user = await requirePermission("integration.configure");
    await enqueue({
      kind: "integration.health_check",
      idempotencyKey: `integration.health_check:${Date.now()}`,
      maxAttempts: 1,
      actor: { kind: "user", id: user.id, name: user.name },
    });
    return "Health check queued.";
  }, ["/studio/integrations", "/studio/jobs"]);
}

export async function pollRumbleNowAction(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  return guarded(async () => {
    const user = await requirePermission("job.retry");
    await enqueue({
      kind: "rumble.poll_live",
      idempotencyKey: `rumble.poll_live:${Date.now()}`,
      maxAttempts: 1,
      actor: { kind: "user", id: user.id, name: user.name },
    });
    return "Rumble poll queued.";
  }, ["/studio/integrations", "/studio/jobs", "/studio"]);
}

/* --------------------------------------------------------------- Buzzsprout */

/**
 * Connect Buzzsprout.
 *
 * The token is verified before it is stored — `GET /api/podcasts.json` is the
 * one call that needs no podcast id, so it proves the credential and discovers
 * what it points at in a single request. A token that cannot reach a podcast
 * is not saved.
 *
 * The token never leaves the server, is never rendered back, and is stored
 * AES-256-GCM encrypted like every other provider credential.
 */
export async function connectBuzzsproutAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const apiToken = String(formData.get("apiToken") ?? "").trim();
  const requestedPodcastId = String(formData.get("podcastId") ?? "").trim();

  return guarded(async () => {
    const user = await requirePermission("integration.configure");
    if (!apiToken) throw new Error("Paste the Buzzsprout API token.");

    const { podcasts } = await verifyToken(apiToken);
    if (podcasts.length === 0) {
      throw new Error(
        "That token is valid but reaches no podcasts. Check it was copied from the " +
          "right Buzzsprout account.",
      );
    }

    const chosen = requestedPodcastId
      ? podcasts.find((p) => String(p.id) === requestedPodcastId)
      : podcasts.length === 1
        ? podcasts[0]
        : podcasts.find((p) => String(p.id) === "1762960");

    if (!chosen) {
      throw new Error(
        `This token reaches ${podcasts.length} podcasts (` +
          podcasts.map((p) => `${p.id} ${p.title}`).join(", ") +
          "). Enter the podcast ID to say which one.",
      );
    }

    await saveCredential({
      provider: "BUZZSPROUT",
      kind: "API_KEY",
      payload: { apiToken, podcastId: String(chosen.id) },
      accountLabel: chosen.title,
      accountExternalId: String(chosen.id),
      actor: { kind: "user", id: user.id, name: user.name },
      connectedBy: user.id,
    });

    return `Connected to "${chosen.title}" (podcast ${chosen.id}).`;
  }, ["/studio/integrations", "/studio"]);
}

export async function connectWordPressAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const rawSite = String(formData.get("siteUrl") ?? "").trim();
  const username = String(formData.get("username") ?? "").trim();
  const applicationPassword = String(formData.get("applicationPassword") ?? "");

  return guarded(async () => {
    const user = await requirePermission("integration.configure");

    const siteUrl = normalizeSiteUrl(rawSite || "https://jeffreyprather.com");
    if (!siteUrl) throw new Error("That site address does not parse as a URL.");
    if (!username) throw new Error("Enter the WordPress username.");
    if (!applicationPassword.trim()) {
      throw new Error("Paste the Application Password from your WordPress profile.");
    }

    // Verify before storing, and verify CAPABILITIES rather than just the
    // login: a credential that authenticates but cannot upload media would
    // fail later, while an episode is being published, which is the worst
    // possible moment to find out.
    const identity = await verifyCredentials({ siteUrl, username, applicationPassword });

    if (!identity.canEditPosts) {
      throw new Error(
        `${identity.name} can sign in but cannot create posts on ${siteUrl}. ` +
          "That user needs at least the Author role.",
      );
    }
    if (!identity.canUploadFiles) {
      throw new Error(
        `${identity.name} can create posts but cannot upload files, so the ` +
          "thumbnail could never be attached. That user needs upload permission.",
      );
    }

    await saveCredential({
      provider: "WORDPRESS",
      kind: "API_KEY",
      payload: { siteUrl, username, applicationPassword },
      accountLabel: identity.siteName ?? siteUrl.replace(/^https?:\/\//, ""),
      accountExternalId: String(identity.id),
      actor: { kind: "user", id: user.id, name: user.name },
      connectedBy: user.id,
    });

    return `Connected to ${identity.siteName ?? siteUrl} as ${identity.name}. Posts are created as drafts.`;
  }, ["/studio/integrations", "/studio"]);
}

/** Read recent Buzzsprout episodes. Read-only: nothing is created or changed. */
export async function syncBuzzsproutAction(
  _prev?: ActionState,
): Promise<ActionState> {
  return guarded(async () => {
    await requirePermission("integration.configure");
    const { enqueue } = await import("@/lib/queue/queue");
    await enqueue({
      kind: "buzzsprout.sync_recent",
      idempotencyKey: `buzzsprout.sync_recent:${Date.now()}`,
      maxAttempts: 2,
    });
    return "Reading recent episodes from Buzzsprout.";
  }, ["/studio/integrations"]);
}
