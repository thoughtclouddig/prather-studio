import Link from "next/link";
import { desc, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs, shows } from "@/db/schema";
import { listEpisodes, needsAttention, type EpisodeRow } from "@/lib/domain/episodes";
import {
  PACKAGING_LABEL,
  PACKAGING_TONE,
  PHASE_LABEL,
  PHASE_TONE,
  PLATFORM_LABEL,
  PUBLICATION_STATE_LABEL,
  PUBLICATION_STATE_TONE,
  READINESS_LABEL,
  READINESS_TONE,
} from "@/lib/domain/vocabulary";
import { countdown, relative, shortDate, showDateTime } from "@/lib/format";
import { Empty, Panel, StateBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

/** The next show is the soonest episode that has not aired. */
function pickNextShow(rows: EpisodeRow[]): EpisodeRow | undefined {
  return rows
    .filter((r) => !r.airedAt && r.scheduledAt)
    .sort((a, b) => a.scheduledAt!.getTime() - b.scheduledAt!.getTime())[0];
}

export default async function Dashboard() {
  const [episodes, show, deadJobs] = await Promise.all([
    listEpisodes(),
    db.select().from(shows).limit(1),
    db
      .select()
      .from(jobs)
      .where(inArray(jobs.state, ["DEAD"]))
      .orderBy(desc(jobs.updatedAt))
      .limit(5),
  ]);

  const next = pickNextShow(episodes);
  const recent = episodes.filter((e) => e.id !== next?.id).slice(0, 6);

  const attention = [
    ...episodes
      .filter((e) => e.proposedDrafts > 0)
      .map((e) => ({
        kind: "Review" as const,
        episodeId: e.id,
        title: e.approvedTitle ?? e.workingTitle,
        detail: `${e.proposedDrafts} draft${e.proposedDrafts === 1 ? "" : "s"} awaiting approval`,
        href: `/studio/episodes/${e.id}/review`,
        tone: "waiting" as const,
      })),
    ...episodes.flatMap((e) =>
      e.publications
        .filter((p) => p.state === "FAILED")
        .map((p) => ({
          kind: "Failed" as const,
          episodeId: e.id,
          title: e.approvedTitle ?? e.workingTitle,
          detail: `${PLATFORM_LABEL[p.platform]} publication failed`,
          href: `/studio/episodes/${e.id}`,
          tone: "problem" as const,
        })),
    ),
    ...deadJobs.map((j) => ({
      kind: "Dead job" as const,
      episodeId: j.episodeId,
      title: j.kind,
      detail: j.lastError?.slice(0, 110) ?? "Exhausted all attempts",
      href: "/studio/jobs?filter=dead",
      tone: "problem" as const,
    })),
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="eyebrow">{show[0]?.name ?? "Show"}</div>
          <h1 className="display text-[26px]">Control desk</h1>
        </div>
        <div className="mono">{show[0]?.cadenceNote}</div>
      </div>

      <div className="grid gap-5 min-w-0 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        {/* ---------------------------------------------------- NEXT SHOW */}
        <Panel
          eyebrow="Next show"
          title={next ? next.workingTitle : "Nothing scheduled"}
          actions={
            next && (
              <Link href={`/studio/episodes/${next.id}`} className="btn btn-ghost btn-xs">
                Open
              </Link>
            )
          }
        >
          {!next ? (
            <Empty>No upcoming episode. Schedule one from Episodes.</Empty>
          ) : (
            <>
              <div className="px-4 py-3.5 border-b border-[var(--color-ink-200)] flex items-end justify-between gap-4 flex-wrap">
                <div>
                  <div className="eyebrow mb-1">Air time</div>
                  <div className="text-[15px] font-semibold">
                    {showDateTime(next.scheduledAt)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="eyebrow mb-1">Countdown</div>
                  <div className="display text-[22px] text-[var(--color-signal-red)]">
                    {countdown(next.scheduledAt)}
                  </div>
                </div>
              </div>

              <table className="grid-table">
                <tbody>
                  <ReadinessRow
                    label="Show"
                    tone={READINESS_TONE[next.showPrepState]}
                    value={READINESS_LABEL[next.showPrepState]}
                    note="StreamYard prep confirmed by an operator"
                  />
                  <ReadinessRow
                    label="Artwork"
                    tone={READINESS_TONE[next.artworkState]}
                    value={READINESS_LABEL[next.artworkState]}
                    note="Square show art, reused across platforms"
                  />
                  {(["RUMBLE", "YOUTUBE", "BUZZSPROUT", "MAILCHIMP"] as const).map(
                    (platform) => {
                      const pub = next.publications.find((p) => p.platform === platform);
                      return (
                        <ReadinessRow
                          key={platform}
                          label={PLATFORM_LABEL[platform]}
                          tone={
                            pub ? PUBLICATION_STATE_TONE[pub.state] : "muted"
                          }
                          value={
                            pub
                              ? PUBLICATION_STATE_LABEL[pub.state]
                              : "Not started"
                          }
                          note={
                            platform === "RUMBLE"
                              ? "Observed only — Rumble has no metadata write API"
                              : pub?.intent === "SKIP"
                                ? "Deliberately skipped"
                                : pub?.intent === "HOLD"
                                  ? "Held by the operator"
                                  : "Waiting on the recording"
                          }
                        />
                      );
                    },
                  )}
                </tbody>
              </table>
            </>
          )}
        </Panel>

        {/* --------------------------------------------- NEEDS ATTENTION */}
        <Panel
          eyebrow="Needs attention"
          title={`${attention.length} item${attention.length === 1 ? "" : "s"}`}
        >
          {attention.length === 0 ? (
            <Empty>Nothing is waiting on you. Everything queued has settled.</Empty>
          ) : (
            <ul>
              {attention.map((item, i) => (
                <li
                  key={i}
                  className="border-b border-[var(--color-ink-200)] last:border-0"
                >
                  <Link
                    href={item.href}
                    className="flex items-start gap-3 px-4 py-3 hover:bg-[var(--color-ink-150)] transition-colors"
                  >
                    <span className="pt-0.5 w-[80px] flex-none">
                      <StateBadge tone={item.tone} label={item.kind} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold truncate">
                        {item.title}
                      </span>
                      <span className="block text-[12px] text-[var(--color-type-lo)] truncate">
                        {item.detail}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* ------------------------------------------------ RECENT EPISODES */}
      <Panel
        eyebrow="Recent episodes"
        title="Archive"
        actions={
          <Link href="/studio/episodes" className="btn btn-ghost btn-xs">
            All episodes
          </Link>
        }
      >
        <div className="overflow-x-auto">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Episode</th>
                <th>Aired</th>
                <th>Phase</th>
                <th>Packaging</th>
                <th>Platforms</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link
                      href={`/studio/episodes/${e.id}`}
                      className="font-semibold hover:text-[var(--color-signal-blue)]"
                    >
                      {e.approvedTitle ?? e.workingTitle}
                    </Link>
                    {!e.approvedTitle && (
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--color-type-lo)]">
                        working title
                      </span>
                    )}
                    {needsAttention(e) && (
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--color-signal-red)]">
                        · needs attention
                      </span>
                    )}
                  </td>
                  <td className="mono whitespace-nowrap">
                    {e.airedAt ? shortDate(e.airedAt) : relative(e.scheduledAt)}
                  </td>
                  <td>
                    <StateBadge tone={PHASE_TONE[e.phase]} label={PHASE_LABEL[e.phase]} />
                  </td>
                  <td>
                    <StateBadge
                      tone={PACKAGING_TONE[e.packaging]}
                      label={PACKAGING_LABEL[e.packaging]}
                    />
                  </td>
                  <td>
                    <PlatformStrip row={e} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function ReadinessRow({
  label,
  tone,
  value,
  note,
}: {
  label: string;
  tone: Parameters<typeof StateBadge>[0]["tone"];
  value: string;
  note: string;
}) {
  return (
    <tr>
      <td className="w-[110px]">
        <span className="eyebrow">{label}</span>
      </td>
      <td className="w-[140px]">
        <StateBadge tone={tone} label={value} />
      </td>
      {/* Supplementary — dropped on narrow screens rather than forcing the
          page to scroll sideways. */}
      <td className="hidden sm:table-cell text-[12px] text-[var(--color-type-lo)]">
        {note}
      </td>
    </tr>
  );
}

/** Compact per-platform summary: initial + state colour, with a title for the
 *  full reading. Dense on purpose — this is a scan, not a report. */
export function PlatformStrip({ row }: { row: EpisodeRow }) {
  const order = ["RUMBLE", "YOUTUBE", "BUZZSPROUT", "MAILCHIMP", "WORDPRESS"] as const;
  return (
    <div className="flex items-center gap-1.5">
      {order.map((platform) => {
        const pub = row.publications.find((p) => p.platform === platform);
        const tone = pub ? PUBLICATION_STATE_TONE[pub.state] : "muted";
        const label = pub ? PUBLICATION_STATE_LABEL[pub.state] : "Not started";
        return (
          <span
            key={platform}
            title={`${PLATFORM_LABEL[platform]}: ${label}`}
            className={`state state-${tone} text-[10px] tracking-[0.04em]`}
          >
            {PLATFORM_LABEL[platform].slice(0, 2).toUpperCase()}
          </span>
        );
      })}
    </div>
  );
}
