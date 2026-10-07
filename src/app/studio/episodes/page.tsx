import Link from "next/link";
import {
  attentionReason,
  listEpisodes,
  needsAttention,
  type EpisodeRow,
} from "@/lib/domain/episodes";
import { classifyEpisode, isPastUnresolved, isUpcoming } from "@/lib/domain/schedule";
import {
  PACKAGING_LABEL,
  PACKAGING_TONE,
  PHASE_LABEL,
  PHASE_TONE,
  PLATFORM_LABEL,
  PUBLICATION_STATE_LABEL,
  PUBLICATION_STATE_TONE,
} from "@/lib/domain/vocabulary";
import { shortDate, showDateTime } from "@/lib/format";
import { Empty, Panel, StateBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "upcoming", label: "Upcoming" },
  { key: "unresolved", label: "Unresolved" },
  { key: "review", label: "Needs review" },
  { key: "published", label: "Published" },
  { key: "attention", label: "Needs attention" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function applyFilter(rows: EpisodeRow[], filter: FilterKey, now: Date): EpisodeRow[] {
  switch (filter) {
    case "upcoming":
      // Upcoming means scheduled in the FUTURE. It used to mean "has no aired
      // stamp", which never expired — a show from last week stayed upcoming
      // forever because nothing had observed it.
      return rows.filter((r) => isUpcoming(r, now));
    case "unresolved":
      return rows.filter((r) => isPastUnresolved(r, now));
    case "review":
      return rows.filter((r) => r.packaging === "REVIEW");
    case "published":
      return rows.filter((r) =>
        r.publications.some((p) => p.state === "PUBLISHED"),
      );
    case "attention":
      return rows.filter((r) => needsAttention(r) || isPastUnresolved(r, now));
    default:
      return rows;
  }
}

const PLATFORM_COLUMNS = ["YOUTUBE", "RUMBLE", "BUZZSPROUT", "MAILCHIMP"] as const;

export default async function EpisodesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter } = await searchParams;
  const active = (FILTERS.find((f) => f.key === filter)?.key ?? "all") as FilterKey;

  const now = new Date();
  const all = await listEpisodes();
  const rows = applyFilter(all, active, now);

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="eyebrow">Archive</div>
          <h1 className="display text-[26px]">Episodes</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="mono">{all.length} total</span>
          <Link href="/studio/episodes/new" className="btn btn-primary btn-xs">
            New episode
          </Link>
        </div>
      </div>

      <nav className="flex flex-wrap items-stretch border border-[var(--color-ink-200)] bg-[var(--color-ink-050)]">
        {FILTERS.map((f) => {
          const count = applyFilter(all, f.key, now).length;
          const on = f.key === active;
          return (
            <Link
              key={f.key}
              href={f.key === "all" ? "/studio/episodes" : `/studio/episodes?filter=${f.key}`}
              className={[
                "px-4 py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] border-r border-[var(--color-ink-200)] last:border-r-0 transition-colors",
                on
                  ? "bg-[var(--color-ink-150)] text-[var(--color-type-hi)]"
                  : "text-[var(--color-type-lo)] hover:text-[var(--color-type-hi)]",
              ].join(" ")}
            >
              {f.label}
              <span className="ml-2 text-[var(--color-type-lo)] font-mono">{count}</span>
            </Link>
          );
        })}
      </nav>

      <Panel>
        {rows.length === 0 ? (
          <Empty>No episodes match this filter.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Episode</th>
                  <th>Air date</th>
                  <th>Phase</th>
                  <th>Packaging</th>
                  {PLATFORM_COLUMNS.map((p) => (
                    <th key={p}>{PLATFORM_LABEL[p]}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="min-w-[280px]">
                      <Link
                        href={`/studio/episodes/${e.id}`}
                        className="font-semibold hover:text-[var(--color-signal-blue)]"
                      >
                        {e.approvedTitle ?? e.workingTitle}
                      </Link>
                      <div className="mono mt-0.5">
                        {e.episodeNumber ? `#${e.episodeNumber} · ` : ""}
                        {e.slug}
                        {classifyEpisode(e, now) === "PAST_UNRESOLVED" && (
                          <span className="text-[var(--color-signal-amber)]">
                            {" "}
                            · past schedule, unresolved
                          </span>
                        )}
                        {attentionReason(e) && (
                          <span className="text-[var(--color-signal-red)]">
                            {" "}
                            · {attentionReason(e)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-[12px]">
                      {e.airedAt ? shortDate(e.airedAt) : showDateTime(e.scheduledAt)}
                    </td>
                    <td>
                      <StateBadge
                        tone={PHASE_TONE[e.phase]}
                        label={PHASE_LABEL[e.phase]}
                      />
                    </td>
                    <td>
                      <StateBadge
                        tone={PACKAGING_TONE[e.packaging]}
                        label={PACKAGING_LABEL[e.packaging]}
                      />
                    </td>
                    {PLATFORM_COLUMNS.map((platform) => {
                      const pub = e.publications.find((p) => p.platform === platform);
                      return (
                        <td key={platform}>
                          <StateBadge
                            tone={pub ? PUBLICATION_STATE_TONE[pub.state] : "muted"}
                            label={
                              pub
                                ? PUBLICATION_STATE_LABEL[pub.state]
                                : "Not started"
                            }
                          />
                        </td>
                      );
                    })}
                    <td className="text-right whitespace-nowrap">
                      {e.packaging === "REVIEW" && (
                        <Link
                          href={`/studio/episodes/${e.id}/review`}
                          className="btn btn-xs"
                        >
                          Review
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
