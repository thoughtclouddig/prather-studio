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
  READINESS_LABEL,
  READINESS_TONE,
} from "@/lib/domain/vocabulary";
import { relative, showDateTime, stamp } from "@/lib/format";
import { Empty, Panel, StateBadge } from "@/components/ui";
import { updateEpisodeAction } from "@/app/studio/actions";
import { DraftCard, EpisodeForm, PublicationRow } from "./parts";

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
  const [detail, user] = await Promise.all([getEpisodeDetail(id), requireUser()]);
  if (!detail) notFound();

  const { episode, show, publications, drafts, liveDrafts, packaging, activity, jobs } =
    detail;
  const canEdit = can(user.role, "episode.edit");
  const canReview = can(user.role, "draft.approve");
  const proposed = liveDrafts.filter((d) => d.state === "PROPOSED");

  const ordered = PLATFORM_ORDER.map((p) =>
    publications.find((pub) => pub.platform === p),
  ).filter(Boolean);

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

        {proposed.length > 0 && (
          <Link href={`/studio/episodes/${episode.id}/review`} className="btn btn-primary">
            Review {proposed.length} item{proposed.length === 1 ? "" : "s"}
          </Link>
        )}
      </div>

      {/* ------------------------------------------------------- EPISODE */}
      <Panel eyebrow="Episode" title="Identity &amp; schedule">
        <EpisodeForm episode={episode} canEdit={canEdit} action={updateEpisodeAction} />
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
        actions={<span className="mono">no platform is connected in this build</span>}
      >
        <div className="overflow-x-auto">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Intent</th>
                <th>State</th>
                <th>External</th>
                <th className="text-right">Dev action</th>
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
