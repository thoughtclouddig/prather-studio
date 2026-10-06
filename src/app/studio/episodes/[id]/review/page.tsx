import Link from "next/link";
import { notFound } from "next/navigation";
import { getEpisodeDetail } from "@/lib/domain/episodes";
import { requireUser } from "@/lib/auth/require";
import { can } from "@/lib/auth/authorize";
import {
  PLATFORM_LABEL,
  PLATFORM_ORDER,
  PUBLICATION_STATE_LABEL,
  PUBLICATION_STATE_TONE,
} from "@/lib/domain/vocabulary";
import { showDateTime } from "@/lib/format";
import { Panel, StateBadge, BackToEpisode} from "@/components/ui";
import { DraftCard, PublicationRow } from "../parts";

export const dynamic = "force-dynamic";

/**
 * REVIEW MODE.
 *
 * One continuous screen, in the order an operator actually decides things:
 * headline → alternates → summary → platform copy → chapters → destinations.
 *
 * The two-minute pass is the whole design target. If approving an episode ever
 * requires visiting six tabs, this build has recreated the six-platform problem
 * inside our own app.
 */
const SECTIONS: Array<{ key: string; title: string; fields: string[] }> = [
  { key: "headline", title: "1 · Headline", fields: ["primary_headline"] },
  { key: "alternates", title: "2 · Alternate headlines", fields: ["alternate_headline"] },
  { key: "summary", title: "3 · Summary", fields: ["summary_short", "summary_long"] },
  {
    key: "descriptions",
    title: "4 · Platform copy",
    fields: ["platform_description", "social_caption"],
  },
  { key: "chapters", title: "5 · Chapters", fields: ["chapters"] },
];

export default async function ReviewMode({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, user] = await Promise.all([getEpisodeDetail(id), requireUser()]);
  if (!detail) notFound();

  const { episode, liveDrafts, publications } = detail;
  const canReview = can(user.role, "draft.approve");
  const canEdit = can(user.role, "episode.edit");

  const open = liveDrafts.filter((d) => d.state === "PROPOSED");
  const decided = liveDrafts.filter((d) => d.state !== "PROPOSED");
  const used = new Set<string>();

  const ordered = PLATFORM_ORDER.map((p) =>
    publications.find((pub) => pub.platform === p),
  ).filter(Boolean);

  return (
    <div className="space-y-5 max-w-[900px] mx-auto">
      {/* Sticky progress: the operator always knows how much is left. */}
      <div className="sticky top-12 z-10 -mx-4 px-4 py-3 bg-[var(--color-ink-000)] border-b border-[var(--color-ink-200)]">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-3 mb-0.5">
              <BackToEpisode episodeId={episode.id} />
              <span className="eyebrow">Review · {showDateTime(episode.scheduledAt)}</span>
            </div>
            <div className="display text-[17px] truncate">
              {episode.approvedTitle ?? episode.workingTitle}
            </div>
          </div>
          <div className="flex items-center gap-4 flex-none">
            <div className="text-right">
              <div className="eyebrow">Remaining</div>
              <div
                className={`display text-[20px] ${
                  open.length === 0
                    ? "text-[var(--color-signal-green)]"
                    : "text-[var(--color-signal-amber)]"
                }`}
              >
                {open.length}
              </div>
            </div>
            <Link href={`/studio/episodes/${episode.id}`} className="btn btn-ghost btn-xs">
              Workspace
            </Link>
          </div>
        </div>
        <div className="mt-2 h-[3px] bg-[var(--color-ink-200)]">
          <div
            className="h-full bg-[var(--color-signal-green)] transition-all"
            style={{
              width: `${
                liveDrafts.length === 0
                  ? 100
                  : Math.round((decided.length / liveDrafts.length) * 100)
              }%`,
            }}
          />
        </div>
      </div>

      {open.length === 0 && (
        <div className="panel px-4 py-3 text-[13px] text-[var(--color-signal-green)]">
          Everything in this episode has been decided. Set the destinations below,
          then the episode is ready to dispatch.
        </div>
      )}

      {SECTIONS.map((section) => {
        const items = liveDrafts.filter((d) => section.fields.includes(d.field));
        items.forEach((d) => used.add(d.id));
        if (items.length === 0) return null;
        return (
          <Panel key={section.key} eyebrow={section.title} title={undefined}>
            <div className="divide-y divide-[var(--color-ink-200)]">
              {items.map((draft) => (
                <div key={draft.id} className="p-2">
                  <DraftCard
                    draft={draft}
                    episodeId={episode.id}
                    canReview={canReview}
                    compact
                  />
                </div>
              ))}
            </div>
          </Panel>
        );
      })}

      {liveDrafts.some((d) => !used.has(d.id)) && (
        <Panel eyebrow="Other drafts">
          <div className="divide-y divide-[var(--color-ink-200)]">
            {liveDrafts
              .filter((d) => !used.has(d.id))
              .map((draft) => (
                <div key={draft.id} className="p-2">
                  <DraftCard
                    draft={draft}
                    episodeId={episode.id}
                    canReview={canReview}
                    compact
                  />
                </div>
              ))}
          </div>
        </Panel>
      )}

      <Panel
        eyebrow="6 · Destinations"
        title="Where this episode goes"
        actions={<span className="mono">intent is a decision; state is what happened</span>}
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
                />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="panel px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="text-[12px] text-[var(--color-type-lo)]">
          Summary:{" "}
          {ordered.filter((p) => p!.intent === "PUBLISH").length} publishing ·{" "}
          {ordered.filter((p) => p!.intent === "HOLD").length} held ·{" "}
          {ordered.filter((p) => p!.intent === "SKIP").length} skipped
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {ordered
            .filter((p) => p!.intent === "PUBLISH")
            .map((p) => (
              <span key={p!.id} title={PLATFORM_LABEL[p!.platform]}>
                <StateBadge
                  tone={PUBLICATION_STATE_TONE[p!.state]}
                  label={`${PLATFORM_LABEL[p!.platform]} ${PUBLICATION_STATE_LABEL[p!.state]}`}
                />
              </span>
            ))}
        </div>
      </div>
    </div>
  );
}
