import Link from "next/link";
import { notFound } from "next/navigation";
import { getEpisodeDetail } from "@/lib/domain/episodes";
import { requireUser } from "@/lib/auth/require";
import { can } from "@/lib/auth/authorize";
import {
  JOB_STATE_TONE,
  PACKAGING_LABEL,
  PACKAGING_TONE,
  PHASE_LABEL,
  PHASE_TONE,
  PLATFORM_ORDER,
  PUBLICATION_STATE_LABEL,
  PUBLICATION_STATE_TONE,
  READINESS_LABEL,
  READINESS_TONE,
} from "@/lib/domain/vocabulary";
import { relative, showDateTime, stamp } from "@/lib/format";
import type { JobState, Platform } from "@/db/schema";
import { diagnosticsEnabled } from "@/lib/diagnostics";
import { Empty, Panel, StateBadge } from "@/components/ui";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodeImages, settings } from "@/db/schema";
import { buildThumbnailBrief, slugFor } from "@/lib/images/thumbnail-brief";
import { BuzzsproutAudioUpload } from "./buzzsprout-parts";
import { RumbleHandoff } from "./rumble-parts";
import {
  normalizeRumbleVideoUrl,
  rumbleLinkLabel,
} from "@/lib/integrations/rumble/video-url";
import { CreateBuzzsproutDraft, CreateWordPressDraft } from "./publish-parts";
import { ThumbnailStep } from "./thumbnail-parts";
import { updateEpisodeAction } from "@/app/studio/actions";
import { latestTranscript } from "@/lib/domain/transcripts";
import { topicLines } from "@/lib/domain/intake";
import { describeGap, resolveSendTime } from "@/lib/email/send-time";
import { getIntegration } from "@/lib/integrations/credentials";
import { formatTimestamp } from "@/lib/transcripts/parse";
import { DraftCard, EpisodeForm, PublicationRow } from "./parts";
import {
  FetchCaptionsButton,
  RegenerateContentButton,
  RunPackageButton,
  RunPreShowButton,
  UnlinkYouTubeButton,
} from "./pipeline";

/**
 * Platforms with a real adapter as of Phase 3.
 *
 * Kept beside the UI that renders it because the honest distinction between
 * "we did this" and "we pretended to" is a presentation-level promise: a row
 * offering SIMULATE next to a genuinely connected provider is how a simulated
 * publish gets mistaken for a real one.
 */
/**
 * What the background job behind a step is actually doing.
 *
 * Without this, pressing a button that enqueues work gives no visible result
 * at all: the drafts are not there yet, the row still says "No drafts", and
 * the job's state and its error live on a different page. The operator is left
 * with a control that appears to do nothing — which is how a working queue and
 * a broken one look identical.
 */
function JobStatus({
  job,
}: {
  job:
    | {
        state: JobState;
        attempts: number;
        maxAttempts: number;
        updatedAt: Date;
        runAfter: Date | null;
        lastError: string | null;
      }
    | undefined;
}) {
  if (!job) return null;

  const waiting = job.state === "PENDING" && job.runAfter && job.runAfter > new Date();

  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <StateBadge tone={JOB_STATE_TONE[job.state]} label={job.state} />
        <span className="mono text-[11px] text-[var(--color-type-lo)]">
          attempt {job.attempts}/{job.maxAttempts} · {relative(job.updatedAt)}
          {waiting && job.runAfter ? ` · next try ${relative(job.runAfter)}` : ""}
        </span>
      </div>
      {job.lastError && (
        <p
          className={`text-[11px] leading-snug ${
            job.state === "DEAD" || job.state === "FAILED"
              ? "text-[var(--color-signal-red)]"
              : "text-[var(--color-type-lo)]"
          }`}
        >
          {job.lastError}
        </p>
      )}
    </div>
  );
}

const REAL_PLATFORMS = new Set<Platform>(["YOUTUBE", "RUMBLE", "BUZZSPROUT"]);

export const dynamic = "force-dynamic";

/** Capability notes drawn from the Phase 0 audit. They are the reason a row
 *  behaves the way it does, so they belong next to the row. */
const PLATFORM_NOTE: Record<string, string> = {
  RUMBLE: "Observed only — no metadata write API",
  YOUTUBE: "Full API: upload, metadata, thumbnail, captions",
  BUZZSPROUT: "Audio + show notes via API",
  MAILCHIMP: "Draft or scheduled campaign",
  WORDPRESS: "Interim target via REST until the new site ships",
  WEBSITE: "Reads the canonical record directly",
  OPUSCLIP: "Submit source, receive scored clips",
  LOCALS: "No write API — manual handoff",
};

export default async function EpisodeWorkspace({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, user, transcriptResult, youtubeIntegration] = await Promise.all([
    getEpisodeDetail(id),
    requireUser(),
    latestTranscript(id),
    getIntegration("YOUTUBE"),
  ]);
  if (!detail) notFound();

  const { episode, show, publications, drafts, liveDrafts, packaging, activity, jobs } =
    detail;
  const canEdit = can(user.role, "episode.edit");
  const canReview = can(user.role, "draft.approve");
  const proposed = liveDrafts.filter((d) => d.state === "PROPOSED");

  const ordered = PLATFORM_ORDER.map((p) =>
    publications.find((pub) => pub.platform === p),
  ).filter(Boolean);

  const youtubePub = publications.find((p) => p.platform === "YOUTUBE");
  const buzzsproutPub = publications.find((p) => p.platform === "BUZZSPROUT");
  const wordpressPub = publications.find((p) => p.platform === "WORDPRESS");
  const rumblePub = publications.find((p) => p.platform === "RUMBLE");
  // An embed id that lost its leading "v" 404s; a page URL and an embed URL
  // are different things and only one of them is somewhere to send a person.
  const rumbleLink = normalizeRumbleVideoUrl(rumblePub?.externalUrl);

  // The same approved copy YouTube receives — one source, several destinations.
  const approvedDescription =
    drafts.find((d) => d.field === "platform_description" && d.state === "APPROVED")?.value ??
    drafts.find((d) => d.field === "summary_long" && d.state === "APPROVED")?.value ??
    null;
  const approvedChapters =
    drafts.find((d) => d.field === "chapters" && d.state === "APPROVED")?.value ?? null;

  // Only the current ones. Superseded attempts are history, not the picture.
  const images = await db
    .select({
      id: episodeImages.id,
      kind: episodeImages.kind,
      width: episodeImages.width,
      height: episodeImages.height,
    })
    .from(episodeImages)
    .where(
      and(
        eq(episodeImages.episodeId, episode.id),
        eq(episodeImages.state, "ACCEPTED"),
      ),
    );
  const mailchimpPub = publications.find((p) => p.platform === "MAILCHIMP");

  // The send time is shown on the episode page, not only on the briefing page,
  // because "when does this go out" is the question asked while scanning the
  // morning's work — not after committing to open a sub-page.
  const [config] = await db.select().from(settings).where(eq(settings.id, "global")).limit(1);
  const sendTime = episode.scheduledAt
    ? resolveSendTime({
        scheduledAt: episode.scheduledAt,
        sendTime: config?.emailSendTime,
        sendTimezone: config?.emailSendTimezone,
      })
    : null;

  const hostTopicCount = topicLines(episode.hostTopics).length;
  const emailDrafts = liveDrafts.filter((d) => d.field.startsWith("email_"));

  const linkedVideoId = youtubePub?.externalId ?? null;
  const youtubeConnected = youtubeIntegration?.health === "CONNECTED";
  const transcript = transcriptResult?.transcript ?? null;
  const hasDrafts = liveDrafts.length > 0;

  // jobs arrive newest-first, so the first match is the current one.
  const latestJob = (kind: string) => jobs.find((j) => j.kind === kind);
  const packageJob = latestJob("episode.package");
  const captionsJob = latestJob("youtube.fetch_captions");
  const preShowJob = latestJob("episode.pre_show");

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="eyebrow">
            <Link href="/studio/episodes" className="hover:text-[var(--color-type-hi)]">
              Episodes
            </Link>
            {" / "}
            {show.name}
            {episode.episodeNumber ? ` / #${episode.episodeNumber}` : ""}
          </div>
          <h1 className="display text-[24px] mt-1">
            {episode.approvedTitle ?? episode.workingTitle}
          </h1>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            <StateBadge tone={PHASE_TONE[episode.phase]} label={PHASE_LABEL[episode.phase]} />
            <StateBadge tone={PACKAGING_TONE[packaging]} label={PACKAGING_LABEL[packaging]} />
            <StateBadge
              tone={READINESS_TONE[episode.artworkState]}
              label={`Artwork ${READINESS_LABEL[episode.artworkState]}`}
            />
            <span className="mono">
              {episode.airedAt
                ? `aired ${showDateTime(episode.airedAt)}`
                : `scheduled ${showDateTime(episode.scheduledAt)}`}
            </span>
          </div>
          {!episode.approvedTitle && (
            <p className="text-[11px] text-[var(--color-type-lo)] mt-1.5">
              Showing the working title — no headline has been approved yet.
            </p>
          )}
        </div>

        {/* Always present. It used to appear only once proposals existed, so
            "Proposals will appear in Review" named a destination with no visible
            way to reach it — the operator was told to go somewhere that was not
            on screen. */}
        <Link
          href={`/studio/episodes/${episode.id}/review`}
          className={`btn ${proposed.length > 0 ? "btn-primary" : "btn-ghost"}`}
        >
          {proposed.length > 0
            ? `Review ${proposed.length} item${proposed.length === 1 ? "" : "s"}`
            : "Review"}
        </Link>
      </div>

      {/* ------------------------------------------------------- EPISODE */}
      <Panel eyebrow="Episode" title="Identity &amp; schedule">
        <EpisodeForm episode={episode} canEdit={canEdit} action={updateEpisodeAction} />
      </Panel>

      {/* ---------------------------------------------- BEFORE THE SHOW */}
      {/* These three steps need only what Jeff submitted in the morning. They
          used to sit below the transcript-dependent ones, which put the day's
          first work at the bottom of the page and implied the email had to
          wait for captions that do not exist until hours after it has gone
          out. The order on screen now matches the order of the day. */}
      <Panel
        eyebrow="Before the show"
        title="From Jeff&rsquo;s submission, hours before air"
        actions={
          sendTime ? (
            <span className="mono">briefing sends {sendTime.label}</span>
          ) : (
            <span className="mono">no air date</span>
          )
        }
      >
        <table className="grid-table">
          <tbody>
            {/* 1 — the morning form. Everything pre-show reads from this. */}
            <tr>
              <td className="w-[150px] align-top">
                <span className="eyebrow">1 &middot; Submission</span>
              </td>
              <td className="w-[160px] align-top">
                <StateBadge
                  tone={episode.hostHeadline ? "done" : "muted"}
                  label={episode.hostHeadline ? "Received" : "Not submitted"}
                />
              </td>
              <td className="align-top">
                {episode.hostHeadline ? (
                  <div className="space-y-1">
                    <p className="text-[12px] leading-snug">
                      &ldquo;{episode.hostHeadline}&rdquo;
                    </p>
                    <p className="text-[11px] text-[var(--color-type-lo)]">
                      {hostTopicCount} topic{hostTopicCount === 1 ? "" : "s"}
                      {episode.hostBrief ? " · write-up supplied" : " · no write-up"}
                      {episode.submittedAt ? ` · ${relative(episode.submittedAt)}` : ""}
                    </p>
                  </div>
                ) : (
                  <span className="text-[12px] text-[var(--color-type-lo)]">
                    Jeff has not filled the form for this show yet. His headline is what
                    the thumbnail and the email are built from.
                  </span>
                )}
              </td>
              <td className="w-[210px] align-top text-right">
                <Link href="/submit" className="btn btn-xs btn-ghost" target="_blank">
                  Open the form
                </Link>
              </td>
            </tr>

            {/* 2 — Claude, reading the submission rather than a transcript */}
            <tr>
              <td className="align-top">
                <span className="eyebrow">2 &middot; Email copy</span>
              </td>
              <td className="align-top">
                <StateBadge
                  tone={
                    emailDrafts.some((d) => d.state === "APPROVED")
                      ? "done"
                      : emailDrafts.length > 0
                        ? "waiting"
                        : episode.hostHeadline
                          ? "ready"
                          : "muted"
                  }
                  label={
                    emailDrafts.some((d) => d.state === "APPROVED")
                      ? "Approved"
                      : emailDrafts.length > 0
                        ? "Awaiting review"
                        : episode.hostHeadline
                          ? "Not run"
                          : "Waiting on Jeff"
                  }
                />
              </td>
              <td className="align-top">
                <span className="text-[12px] text-[var(--color-type-lo)]">
                  {emailDrafts.length > 0
                    ? "Three subject lines, a preview line, the brief and his bullets — all PROPOSED until approved in Review."
                    : "Reads his headline, topics and write-up. No transcript required, so this can run the moment he submits."}
                </span>
                <JobStatus job={preShowJob} />
              </td>
              <td className="align-top text-right">
                {canEdit && (
                  <RunPreShowButton
                    episodeId={episode.id}
                    disabled={!episode.hostHeadline}
                    hasDrafts={emailDrafts.length > 0}
                  />
                )}
              </td>
            </tr>

            {/* 3 — the only step that reaches an audience by itself */}
            <tr>
              <td className="align-top">
                <span className="eyebrow">3 &middot; Briefing</span>
              </td>
              <td className="align-top">
                <StateBadge
                  tone={
                    mailchimpPub?.state === "SCHEDULED"
                      ? "done"
                      : emailDrafts.some((d) => d.state === "APPROVED")
                        ? "ready"
                        : "muted"
                  }
                  label={
                    mailchimpPub?.state === "SCHEDULED"
                      ? "Scheduled"
                      : emailDrafts.some((d) => d.state === "APPROVED")
                        ? "Ready to schedule"
                        : "Awaiting approved copy"
                  }
                />
              </td>
              <td className="align-top">
                {sendTime ? (
                  <span className="text-[12px] text-[var(--color-type-lo)]">
                    Goes out{" "}
                    <strong className="text-[var(--color-type-mid)]">
                      {sendTime.label}
                    </strong>{" "}
                    &mdash; {describeGap(sendTime.gapToAirMinutes)}. Scheduled in
                    Mailchimp as a draft; nothing is ever sent on sight.
                  </span>
                ) : (
                  <span className="text-[12px] text-[var(--color-type-lo)]">
                    Set an air date before scheduling the briefing.
                  </span>
                )}
              </td>
              <td className="align-top text-right">
                <Link
                  href={`/studio/episodes/${episode.id}/briefing`}
                  className={`btn btn-xs ${
                    mailchimpPub?.state !== "SCHEDULED" &&
                    emailDrafts.some((d) => d.state === "APPROVED")
                      ? "btn-primary"
                      : ""
                  }`}
                >
                  {mailchimpPub?.state === "SCHEDULED" ? "View briefing" : "Review & schedule"}
                </Link>
              </td>
            </tr>
          </tbody>
        </table>
      </Panel>

      {/* -------------------------------------------------- THUMBNAIL
          The brief goes out, the images come back. The operator's ChatGPT
          thread carries months of previous thumbnails and produces excellent
          work every week; the same brief sent to the image API did not. So
          the Studio removes the steps around that process rather than trying
          to replace it. */}
      <Panel
        eyebrow="Before the show"
        title="4 &middot; Thumbnail — brief out, artwork back"
        actions={
          <StateBadge
            tone={
              images.some((i) => i.kind === "THUMBNAIL_16_9") &&
              images.some((i) => i.kind === "THUMBNAIL_1_1")
                ? "done"
                : images.length > 0
                  ? "waiting"
                  : "muted"
            }
            label={
              images.some((i) => i.kind === "THUMBNAIL_16_9") &&
              images.some((i) => i.kind === "THUMBNAIL_1_1")
                ? "Both uploaded"
                : images.length > 0
                  ? "One of two"
                  : "Not started"
            }
          />
        }
      >
        {/* The headline comes from Jeff's submission, not from the
            transcript. Blocking the artwork until captions arrive made the
            thumbnail wait hours for a headline he had already written that
            morning — the ordering was backwards. An approved editorial
            headline still wins when one exists. */}
        <ThumbnailStep
          episodeId={episode.id}
          headlineSource={
            episode.approvedTitle
              ? "approved"
              : episode.hostHeadline
                ? "host"
                : "none"
          }
          brief={buildThumbnailBrief({
            headline:
              episode.approvedTitle ?? episode.hostHeadline ?? episode.workingTitle,
            slug: slugFor(
              episode.approvedTitle ?? episode.hostHeadline ?? episode.workingTitle,
            ),
          })}
          hasHeadline={!!(episode.approvedTitle ?? episode.hostHeadline)}
          youtubeLinked={!!youtubePub?.externalId}
          existing={images.map((i) => ({
            kind: i.kind,
            id: i.id,
            width: i.width,
            height: i.height,
          }))}
        />
      </Panel>

      {/* ----------------------------------------------- AFTER THE SHOW */}
      {/* Everything here depends on the recording existing. The transcript is
          the gate, and it is not ours to hurry — YouTube's auto-captions can
          take hours after a stream ends. Nothing above this panel waits on it. */}
      <Panel
        eyebrow="After the show"
        title="Recording to reviewable package"
        actions={
          <span className="mono">
            {youtubeConnected ? "YouTube connected" : "YouTube not connected"}
          </span>
        }
      >
        <table className="grid-table">
          <tbody>
            {/* 5 — the canonical link to what already exists on YouTube */}
            <tr>
              <td className="w-[150px] align-top">
                <span className="eyebrow">5 &middot; YouTube video</span>
              </td>
              <td className="w-[160px] align-top">
                <StateBadge
                  tone={linkedVideoId ? "done" : youtubeConnected ? "ready" : "muted"}
                  label={linkedVideoId ? "Linked" : youtubeConnected ? "Not linked" : "Unavailable"}
                />
              </td>
              <td className="align-top">
                {linkedVideoId ? (
                  <a
                    href={`https://www.youtube.com/watch?v=${linkedVideoId}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="link mono"
                  >
                    {linkedVideoId}
                  </a>
                ) : (
                  <span className="text-[12px] text-[var(--color-type-lo)]">
                    {youtubeConnected
                      ? "Match this episode to the video that already exists. Nothing is uploaded."
                      : "Connect YouTube in Integrations to list candidates."}
                  </span>
                )}
              </td>
              <td className="w-[210px] align-top text-right">
                <div className="inline-flex gap-2">
                  <Link href={`/studio/episodes/${episode.id}/match`} className="btn btn-xs">
                    {linkedVideoId ? "Re-match" : "Find video"}
                  </Link>
                  {linkedVideoId && canEdit && <UnlinkYouTubeButton episodeId={episode.id} />}
                </div>
              </td>
            </tr>

            {/* 6 — the transcript, which everything downstream reads */}
            <tr>
              <td className="align-top">
                <span className="eyebrow">6 &middot; Transcript</span>
              </td>
              <td className="align-top">
                <StateBadge
                  tone={transcript ? "done" : linkedVideoId ? "ready" : "muted"}
                  label={transcript ? "Ready" : linkedVideoId ? "Not fetched" : "Waiting on link"}
                />
              </td>
              <td className="align-top">
                {transcript ? (
                  <span className="text-[12px]">
                    {transcript.segmentCount} segments ·{" "}
                    {formatTimestamp(transcript.durationSeconds ?? 0)} ·{" "}
                    <span className="mono">
                      {transcript.source} via {transcript.provider}
                    </span>
                  </span>
                ) : (
                  <span className="text-[12px] text-[var(--color-type-lo)]">
                    Retrieved from the video&rsquo;s own caption track. Auto-captions can take a
                    few hours to appear after a stream ends.
                  </span>
                )}
                <JobStatus job={captionsJob} />
              </td>
              <td className="align-top text-right">
                {canEdit && (
                  <FetchCaptionsButton
                    episodeId={episode.id}
                    disabled={!linkedVideoId || !youtubeConnected}
                    hasTranscript={!!transcript}
                  />
                )}
              </td>
            </tr>

            {/* 7 — Claude, writing only into PROPOSED drafts */}
            <tr>
              <td className="align-top">
                <span className="eyebrow">7 &middot; Content engine</span>
              </td>
              <td className="align-top">
                <StateBadge
                  tone={
                    packaging === "APPROVED"
                      ? "done"
                      : packaging === "REVIEW"
                        ? "waiting"
                        : transcript
                          ? "ready"
                          : "muted"
                  }
                  label={PACKAGING_LABEL[packaging]}
                />
              </td>
              <td className="align-top">
                <span className="text-[12px] text-[var(--color-type-lo)]">
                  {hasDrafts
                    ? "Everything it wrote is a PROPOSED draft until a person approves it."
                    : "Reads the transcript and proposes headlines, summaries, descriptions, chapters and 3–5 clip moments."}
                </span>
                <JobStatus job={packageJob} />
              </td>
              <td className="align-top text-right">
                {canEdit && (
                  <div className="inline-flex flex-col items-end gap-1.5">
                    <RunPackageButton
                      episodeId={episode.id}
                      disabled={!transcript}
                      hasDrafts={hasDrafts}
                    />
                    {hasDrafts && (
                      <RegenerateContentButton
                        episodeId={episode.id}
                        disabled={!transcript}
                      />
                    )}
                  </div>
                )}
              </td>
            </tr>

            {/* 8 — the write, gated on approval */}
            <tr>
              <td className="align-top">
                <span className="eyebrow">8 &middot; YouTube metadata</span>
              </td>
              <td className="align-top">
                <StateBadge
                  tone={
                    !linkedVideoId
                      ? "muted"
                      : packaging === "APPROVED"
                        ? "ready"
                        : "waiting"
                  }
                  label={
                    !linkedVideoId
                      ? "Waiting on link"
                      : packaging === "APPROVED"
                        ? "Ready to send"
                        : "Awaiting approval"
                  }
                />
              </td>
              <td className="align-top">
                <span className="text-[12px] text-[var(--color-type-lo)]">
                  Updates the existing video&rsquo;s title and description. Only APPROVED content
                  is ever sent.
                </span>
              </td>
              <td className="align-top text-right">
                {linkedVideoId && (
                  <Link
                    href={`/studio/episodes/${episode.id}/youtube`}
                    className={`btn btn-xs ${packaging === "APPROVED" ? "btn-primary" : ""}`}
                  >
                    Review diff
                  </Link>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </Panel>

      {/* --------------------------------------------- EDITORIAL/PACKAGING */}
      <Panel
        eyebrow="Editorial"
        title="Packaging"
        actions={
          <span className="mono">
            {liveDrafts.length} live · {drafts.length - liveDrafts.length} superseded
          </span>
        }
      >
        {liveDrafts.length === 0 ? (
          <Empty>
            No packaging drafts yet. The content engine that writes them arrives in a
            later phase.
          </Empty>
        ) : (
          <div className="divide-y divide-[var(--color-ink-200)]">
            {liveDrafts.map((draft) => (
              <div key={draft.id} className="p-2">
                <DraftCard draft={draft} episodeId={episode.id} canReview={canReview} />
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* --------------------------------------------------- DISTRIBUTION */}
      <Panel
        eyebrow="Distribution"
        title="One episode, many publications"
        actions={
          <span className="mono">
            {REAL_PLATFORMS.size} real · {ordered.length - REAL_PLATFORMS.size} awaiting an adapter
          </span>
        }
      >
        <p className="px-4 py-2.5 text-[12px] text-[var(--color-type-lo)] leading-relaxed border-b border-[var(--color-ink-200)]">
          <strong className="text-[var(--color-type-mid)]">Plan is what you intend, not a
          button that publishes.</strong> The actual sends happen elsewhere: YouTube
          metadata and thumbnail from Review and the Thumbnail panel, the podcast from the
          Buzzsprout panel. Rumble is observed only and is never published to.
        </p>
        <div className="overflow-x-auto">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Plan</th>
                <th>State</th>
                <th>External</th>
                <th className="text-right">Adapter</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((pub) => (
                <PublicationRow
                  key={pub!.id}
                  publication={pub!}
                  episodeId={episode.id}
                  canEdit={canEdit}
                  note={PLATFORM_NOTE[pub!.platform]}
                  isReal={REAL_PLATFORMS.has(pub!.platform)}
                  allowSimulation={diagnosticsEnabled()}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ------------------------------------------------------- JOBS */}
        <Panel
          eyebrow="Jobs"
          title="Background work for this episode"
          actions={
            <Link href="/studio/jobs" className="btn btn-ghost btn-xs">
              All jobs
            </Link>
          }
        >
          {jobs.length === 0 ? (
            <Empty>No jobs have run for this episode.</Empty>
          ) : (
            <table className="grid-table">
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td className="mono w-[160px]">{job.kind}</td>
                    <td className="w-[120px]">
                      <StateBadge tone={JOB_STATE_TONE[job.state]} label={job.state} />
                    </td>
                    <td className="mono">
                      {job.attempts}/{job.maxAttempts} · {relative(job.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        {/* --------------------------------------------------- ACTIVITY */}
        {/* ------------------------------------------------------ RUMBLE
            Rumble exposes no metadata write for an existing video, so this is
            a handoff rather than a publish. Tracking the paste beats pretending
            the step does not exist. */}
        <Panel
          eyebrow="Rumble"
          title="Description &amp; chapters — copy and paste"
          actions={<span className="mono">no write API</span>}
        >
          <RumbleHandoff
            description={approvedDescription}
            chapters={approvedChapters}
            videoUrl={rumbleLink?.url ?? null}
            videoLinkLabel={rumbleLink ? rumbleLinkLabel(rumbleLink) : null}
            videoIsEmbedOnly={rumbleLink?.kind === "embed"}
          />
        </Panel>

        {/* ------------------------------------------------- BUZZSPROUT
            The podcast needs a file nobody can fetch for us: StreamYard has no
            API, Rumble exposes no media, YouTube has no media endpoint, and
            Buzzsprout's own CDN blocks scripted clients. See
            docs/PHASE-3-INVESTIGATION.md §7. So the operator supplies it, and
            the Studio is honest about that rather than faking an audio_url. */}
        <Panel
          eyebrow="Buzzsprout"
          title={
            buzzsproutPub?.externalId
              ? `Episode ${buzzsproutPub.externalId}`
              : "Not linked yet"
          }
          actions={
            <StateBadge
              tone={
                buzzsproutPub?.externalId
                  ? PUBLICATION_STATE_TONE[buzzsproutPub.state]
                  : "waiting"
              }
              label={
                buzzsproutPub?.externalId
                  ? PUBLICATION_STATE_LABEL[buzzsproutPub.state]
                  : "Audio required"
              }
            />
          }
        >
          {!buzzsproutPub?.externalId && (
            <div className="px-4 pt-3.5">
              <CreateBuzzsproutDraft
                episodeId={episode.id}
                hasHeadline={!!episode.approvedTitle}
                hasSquare={images.some((i) => i.kind === "THUMBNAIL_1_1")}
              />
            </div>
          )}
          <BuzzsproutAudioUpload
            episodeId={episode.id}
            hasAudio={!!buzzsproutPub?.externalUrl}
            blockedReason={
              episode.approvedTitle
                ? null
                : "Approve the episode copy first — the upload carries the approved " +
                  "title and show notes with it, and audio does not bypass review."
            }
          />
        </Panel>

        {/* -------------------------------------------------- WORDPRESS */}
        <Panel
          eyebrow="WordPress"
          title="The episode post — draft only"
          actions={
            <StateBadge
              tone={wordpressPub?.externalId ? "done" : "muted"}
              label={wordpressPub?.externalId ? `Post ${wordpressPub.externalId}` : "Not created"}
            />
          }
        >
          <div className="px-4 py-3.5">
            {wordpressPub?.externalUrl ? (
              <p className="text-[12px] leading-relaxed">
                Draft created.{" "}
                <a href={wordpressPub.externalUrl} className="link" target="_blank" rel="noreferrer">
                  Open it in WordPress
                </a>{" "}
                to review and publish.
              </p>
            ) : (
              <CreateWordPressDraft
                episodeId={episode.id}
                hasHeadline={!!episode.approvedTitle}
                hasSquare={images.some((i) => i.kind === "THUMBNAIL_1_1")}
              />
            )}
          </div>
        </Panel>

        <Panel
          eyebrow="Activity"
          title="Append-only history"
          actions={<span className="mono">{activity.length} events</span>}
        >
          {activity.length === 0 ? (
            <Empty>No activity recorded yet.</Empty>
          ) : (
            <ol className="max-h-[420px] overflow-y-auto">
              {activity.map((event) => (
                <li
                  key={event.id}
                  className="px-4 py-2.5 border-b border-[var(--color-ink-200)] last:border-0"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[12px]">{event.summary}</span>
                    <span className="mono flex-none">{stamp(event.createdAt)}</span>
                  </div>
                  <div className="mono mt-0.5">
                    {event.verb} · {event.actorLabel}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
    </div>
  );
}
