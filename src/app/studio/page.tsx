import Link from "next/link";
import { desc, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { eq } from "drizzle-orm";
import { activityEvents, jobs, preStreamAssets, shows } from "@/db/schema";
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
import {
  cadenceFrom,
  countdownTo,
  getNextExpectedShowSlot,
  selectCurrentShow,
  selectNextShow,
  selectPastUnresolved,
} from "@/lib/domain/schedule";
import { countsAsOperationalFailure } from "@/lib/diagnostics";
import { preStreamStatus } from "@/lib/domain/pre-stream";
import { relative, shortDate, showDateTime, stamp, toShowInputValue } from "@/lib/format";
import { Empty, StateBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const [episodes, show, deadJobs, activity] = await Promise.all([
    listEpisodes(),
    db.select().from(shows).limit(1),
    db
      .select()
      .from(jobs)
      .where(inArray(jobs.state, ["DEAD"]))
      .orderBy(desc(jobs.updatedAt))
      .limit(5),
    db
      .select({
        id: activityEvents.id,
        verb: activityEvents.verb,
        summary: activityEvents.summary,
        createdAt: activityEvents.createdAt,
        episodeId: activityEvents.episodeId,
      })
      .from(activityEvents)
      .orderBy(desc(activityEvents.createdAt))
      .limit(12),
  ]);

  const now = new Date();
  const cadence = cadenceFrom(show[0] ?? { defaultStartTime: "14:00", timezone: "America/New_York" });

  // Three separate questions, deliberately not collapsed into one card:
  // what is on air, what is next, and what the calendar expects if no episode
  // exists for it yet.
  const currentShow = selectCurrentShow(episodes);
  const next = selectNextShow(episodes, now);
  const expectedSlot = next ? null : getNextExpectedShowSlot(now, cadence);
  const unresolved = selectPastUnresolved(episodes, now);

  // LIVE wins the card when something is actually on air; otherwise the next
  // future episode. A past episode can occupy neither.
  const featured = currentShow ?? next;
  const countdownState = countdownTo(featured?.scheduledAt, now, {
    isLive: !!currentShow,
  });
  const recent = episodes.filter((e) => e.id !== featured?.id).slice(0, 6);

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
    // A scheduled time passing is not evidence the show happened. Until
    // something observes it, the episode is an operator task rather than
    // either upcoming or complete.
    ...unresolved.map((e) => ({
      kind: "Unresolved" as const,
      episodeId: e.id,
      title: e.approvedTitle ?? e.workingTitle,
      detail: `Scheduled ${showDateTime(e.scheduledAt)} — no broadcast observed`,
      href: `/studio/episodes/${e.id}`,
      tone: "problem" as const,
    })),
    // A job that failed on purpose is not an operational problem. A permanent
    // fake alarm is exactly how a real one stops being read.
    ...deadJobs
      .filter((j) => countsAsOperationalFailure(j.kind))
      .map((j) => ({
      kind: "Dead job" as const,
      episodeId: j.episodeId,
      title: j.kind,
      detail: j.lastError?.slice(0, 110) ?? "Exhausted all attempts",
      href: "/studio/jobs?filter=dead",
      tone: "problem" as const,
    })),
  ];

  const preStreamAsset = featured?.preStreamAssetId
    ? ((
        await db
          .select()
          .from(preStreamAssets)
          .where(eq(preStreamAssets.id, featured.preStreamAssetId))
          .limit(1)
      )[0] ?? null)
    : null;
  const preStream = featured
    ? preStreamStatus(featured, preStreamAsset)
    : null;

  const tally = currentShow ? "on" : featured ? "next" : "off";
  const tallyLabel = currentShow ? "On air" : featured ? "Standby" : "Off air";

  return (
    <div className="space-y-6 min-w-0">
      {/* ---------------------------------------------------- IDENTITY */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="wordmark">{show[0]?.name ?? "The Prather Point"}</div>
        <div className="flex items-center gap-5">
          <span className="mono hidden sm:inline">{show[0]?.cadenceNote}</span>
          <span className={`tally tally-${tally}`}>{tallyLabel}</span>
        </div>
      </div>

      {/* --------------------------------------------------- THE AIR BAND
          The one block allowed to dominate. Everything below is subordinate
          to "what is the next show and how long have I got". */}
      <section className={`airband ${currentShow ? "airband-live" : ""}`}>
        <div className="px-5 pt-5 pb-4 flex items-end justify-between gap-6 flex-wrap">
          <div className="min-w-0">
            <div className="eyebrow mb-2">
              {currentShow
                ? "Live now"
                : featured
                  ? "Next show"
                  : "Next expected show"}
            </div>
            <h1 className="display text-[clamp(20px,2.6vw,28px)] mb-2 text-balance">
              {currentShow?.workingTitle ??
                next?.workingTitle ??
                (expectedSlot ? "No episode created yet" : "Nothing scheduled")}
            </h1>
            <div className="text-[14px] text-[var(--color-type-mid)] font-medium">
              {featured
                ? showDateTime(featured.scheduledAt)
                : expectedSlot
                  ? showDateTime(expectedSlot.startsAt)
                  : "No cadence configured"}
            </div>
          </div>

          <div className="flex items-end gap-5 flex-wrap">
            {featured ? (
              <div className="text-right">
                <div className="eyebrow mb-1.5">
                  {countdownState.kind === "live" ? "Status" : "Countdown"}
                </div>
                <div
                  className={`clock ${
                    countdownState.kind === "live"
                      ? "clock-live"
                      : countdownState.kind === "overdue"
                        ? "clock-overdue"
                        : countdownState.kind === "none"
                          ? "clock-none"
                          : ""
                  }`}
                >
                  {countdownState.label}
                </div>
              </div>
            ) : null}

            {featured ? (
              <Link href={`/studio/episodes/${featured.id}`} className="btn btn-ghost">
                Open episode
              </Link>
            ) : expectedSlot ? (
              /* The cadence predicts the slot; a human creates the episode.
                 The Studio never invents one from the calendar. */
              <Link
                href={`/studio/episodes/new?at=${encodeURIComponent(
                  toShowInputValue(expectedSlot.startsAt),
                )}`}
                className="btn btn-primary"
              >
                Create episode
              </Link>
            ) : null}
          </div>
        </div>

        {featured ? (
          <div className="rail">
            <RailCell
              label="Show prep"
              tone={READINESS_TONE[featured.showPrepState]}
              value={READINESS_LABEL[featured.showPrepState]}
              title="StreamYard prep confirmed by an operator"
            />
            {/* A show nobody has chosen a pre-stream video for is not a
                prepared show, so this blocks readiness rather than sitting
                quietly in a settings page. */}
            <RailCell
              label="Pre-stream"
              tone={
                preStream?.state === "CONFIRMED_IN_RUMBLE"
                  ? "done"
                  : preStream?.state === "SELECTED"
                    ? "waiting"
                    : preStream?.state === "NOT_APPLICABLE"
                      ? "muted"
                      : "problem"
              }
              value={
                preStream?.state === "CONFIRMED_IN_RUMBLE"
                  ? (preStream.assetLabel ?? "Set up")
                  : preStream?.state === "SELECTED"
                    ? "Manual setup"
                    : preStream?.state === "NOT_APPLICABLE"
                      ? "Not used"
                      : "Not selected"
              }
              title={preStream?.instruction ?? preStream?.label ?? "Pre-stream video"}
            />
            <RailCell
              label="Artwork"
              tone={READINESS_TONE[featured.artworkState]}
              value={READINESS_LABEL[featured.artworkState]}
              title="Square show art, reused across platforms"
            />
            {(["RUMBLE", "YOUTUBE", "BUZZSPROUT", "MAILCHIMP"] as const).map(
              (platform) => {
                const pub = featured.publications.find((p) => p.platform === platform);
                return (
                  <RailCell
                    key={platform}
                    label={PLATFORM_LABEL[platform]}
                    tone={pub ? PUBLICATION_STATE_TONE[pub.state] : "muted"}
                    value={pub ? PUBLICATION_STATE_LABEL[pub.state] : "Not started"}
                    title={
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
          </div>
        ) : expectedSlot ? (
          <div className="rail">
            <div className="rail-cell col-span-full">
              <div className="rail-key">From the cadence in Settings</div>
              <div className="text-[12px] text-[var(--color-type-lo)] leading-relaxed">
                No episode exists for this slot yet. The schedule predicts when the
                show airs; it never creates the episode for you.
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {/* ------------------------------------------------------- COLUMNS */}
      <div className="grid gap-6 min-w-0 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        {/* --------------------------------------------- RECENT EPISODES */}
        <section className="min-w-0 space-y-3">
          <div className="section-head">
            <div className="flex items-baseline gap-3">
              <h2 className="section-title">Recent episodes</h2>
              <span className="section-count">{episodes.length} total</span>
            </div>
            <Link href="/studio/episodes" className="link text-[12px] font-semibold">
              All episodes &rarr;
            </Link>
          </div>

          {recent.length === 0 ? (
            <div className="panel">
              <Empty>No episodes yet.</Empty>
            </div>
          ) : (
            <div className="panel overflow-x-auto">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Episode</th>
                    <th>Air date</th>
                    <th>Phase</th>
                    <th className="hidden 2xl:table-cell">Packaging</th>
                    <th>Platforms</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((e) => (
                    <tr key={e.id}>
                      <td className="min-w-[210px]">
                        <Link
                          href={`/studio/episodes/${e.id}`}
                          className="font-semibold hover:text-[var(--color-signal-blue)]"
                        >
                          {e.approvedTitle ?? e.workingTitle}
                        </Link>
                        {needsAttention(e) && (
                          <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--color-signal-red)]">
                            needs attention
                          </span>
                        )}
                      </td>
                      {/* An episode that has not aired must not read as though
                          it has — a date under "Air date" with no broadcast
                          behind it is a lie by layout. */}
                      <td className="mono whitespace-nowrap">
                        {e.airedAt ? (
                          shortDate(e.airedAt)
                        ) : (
                          <span className="text-[var(--color-type-lo)]">
                            {shortDate(e.scheduledAt)} &middot; sched
                          </span>
                        )}
                      </td>
                      <td>
                        <StateBadge tone={PHASE_TONE[e.phase]} label={PHASE_LABEL[e.phase]} />
                      </td>
                      <td className="hidden 2xl:table-cell">
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
          )}
        </section>

        {/* --------------------------------------------- NEEDS ATTENTION */}
        <section className="min-w-0 space-y-3">
          <div className="section-head">
            <div className="flex items-baseline gap-3">
              <h2 className="section-title">Needs attention</h2>
              <span className="section-count">
                {attention.length === 0 ? "clear" : attention.length}
              </span>
            </div>
          </div>

          {attention.length === 0 ? (
            <div className="panel">
              <Empty>Nothing is waiting on you.</Empty>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {attention.map((item, i) => (
                <li key={i}>
                  <Link href={item.href} className={`attn attn-${item.tone}`}>
                    <span className="flex items-baseline justify-between gap-3 mb-1">
                      <span className="attn-title truncate">{item.title}</span>
                      <span className="eyebrow flex-none text-[10px]">{item.kind}</span>
                    </span>
                    <span className="attn-note block truncate">{item.detail}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {/* ------------------------------------------------- ACTIVITY
              Why the Studio believes what it believes. Provider observations
              and automatic transitions have to be auditable from here, not
              only from a server log. */}
          <div className="section-head !mt-7">
            <div className="flex items-baseline gap-3">
              <h2 className="section-title">Activity</h2>
              <span className="section-count">last {activity.length}</span>
            </div>
          </div>

          {activity.length === 0 ? (
            <div className="panel">
              <Empty>Nothing has happened yet.</Empty>
            </div>
          ) : (
            <ol className="space-y-0">
              {activity.map((event) => (
                <li
                  key={event.id}
                  className="flex gap-3 py-2 border-b border-[var(--color-ink-200)] last:border-0"
                >
                  <span
                    className="mono flex-none w-[52px] pt-px text-right"
                    title={stamp(event.createdAt)}
                  >
                    {relative(event.createdAt)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] leading-snug text-[var(--color-type-mid)]">
                      {event.episodeId ? (
                        <Link
                          href={`/studio/episodes/${event.episodeId}`}
                          className="hover:text-[var(--color-type-hi)]"
                        >
                          {event.summary}
                        </Link>
                      ) : (
                        event.summary
                      )}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

function RailCell({
  label,
  tone,
  value,
  title,
}: {
  label: string;
  tone: Parameters<typeof StateBadge>[0]["tone"];
  value: string;
  title: string;
}) {
  return (
    <div className="rail-cell" title={`${label}: ${value} — ${title}`}>
      <div className="rail-key">{label}</div>
      <div className={`rail-val state-${tone} ${tone === "muted" ? "rail-muted" : ""}`}>
        <span>{value}</span>
      </div>
    </div>
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
