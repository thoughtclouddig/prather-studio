import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodes } from "@/db/schema";
import { requireUser } from "@/lib/auth/require";
import { getIntegration } from "@/lib/integrations/credentials";
import { loadCandidates } from "@/app/studio/phase2-actions";
import { showDateTime, relative } from "@/lib/format";
import { Empty, Panel, StateBadge } from "@/components/ui";
import { ConfirmMatchButton, ManualLinkForm } from "./parts";

export const dynamic = "force-dynamic";

const CONFIDENCE_TONE = {
  strong: "done",
  possible: "waiting",
  weak: "muted",
} as const;

export default async function MatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireUser();

  const [episode] = await db.select().from(episodes).where(eq(episodes.id, id)).limit(1);
  if (!episode) notFound();

  const youtube = await getIntegration("YOUTUBE");

  let result: Awaited<ReturnType<typeof loadCandidates>> | null = null;
  let loadError: string | null = null;
  if (youtube?.health === "CONNECTED") {
    try {
      result = await loadCandidates(id);
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
  }

  return (
    <div className="space-y-5 max-w-[1000px]">
      <div>
        <div className="eyebrow">
          <Link href={`/studio/episodes/${id}`} className="hover:text-[var(--color-type-hi)]">
            {episode.workingTitle}
          </Link>
          {" / Match"}
        </div>
        <h1 className="display text-[24px] mt-1">Find this episode on YouTube</h1>
        <p className="text-[12px] text-[var(--color-type-lo)] mt-1.5">
          Scheduled {showDateTime(episode.scheduledAt)}
          {episode.airedAt ? ` · aired ${showDateTime(episode.airedAt)}` : ""}
        </p>
      </div>

      {!youtube || youtube.health !== "CONNECTED" ? (
        <div className="panel px-4 py-3 border-l-2 border-l-[var(--color-signal-amber)]">
          <p className="text-[13px]">
            YouTube is not connected, so candidates cannot be listed.{" "}
            <Link href="/studio/integrations" className="link">
              Connect it in Integrations
            </Link>
            , or enter a video ID by hand below.
          </p>
        </div>
      ) : loadError ? (
        <div className="panel px-4 py-3 border-l-2 border-l-[var(--color-signal-red)]">
          <p className="text-[13px] text-[var(--color-signal-red)]">{loadError}</p>
        </div>
      ) : null}

      {result?.ambiguous && (
        <div className="panel px-4 py-3 border-l-2 border-l-[var(--color-signal-amber)]">
          <p className="text-[13px]">
            <strong className="text-[var(--color-signal-amber)]">Ambiguous.</strong> The top two
            candidates score within 15 points of each other, so the Studio will not guess. Check
            both before confirming.
          </p>
        </div>
      )}

      <Panel
        eyebrow="Candidates"
        title="Recent uploads, ranked by air-date proximity then title"
        actions={<span className="mono">nothing attaches without a confirmation</span>}
      >
        {!result || result.candidates.length === 0 ? (
          <Empty>No candidates to show.</Empty>
        ) : (
          <ul className="divide-y divide-[var(--color-ink-200)]">
            {result.candidates.map((candidate) => (
              <li key={candidate.video.id} className="p-4 flex gap-4 items-start">
                {candidate.video.thumbnailUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={candidate.video.thumbnailUrl}
                    alt=""
                    className="w-[120px] flex-none border border-[var(--color-ink-200)]"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5 flex-wrap mb-1">
                    <StateBadge
                      tone={CONFIDENCE_TONE[candidate.confidence]}
                      label={`${candidate.confidence} · ${candidate.score}`}
                    />
                    {candidate.video.live?.actualEndTime && (
                      <span className="tag">Livestream</span>
                    )}
                  </div>
                  <div className="text-[14px] font-semibold leading-snug">
                    {candidate.video.title}
                  </div>
                  <div className="mono mt-1">
                    {candidate.video.id} · published {relative(new Date(candidate.video.publishedAt))}
                    {candidate.video.durationSeconds
                      ? ` · ${Math.round(candidate.video.durationSeconds / 60)} min`
                      : ""}
                  </div>
                  <ul className="mt-1.5 space-y-0.5">
                    {candidate.reasons.map((reason) => (
                      <li key={reason} className="text-[11px] text-[var(--color-type-lo)]">
                        · {reason}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex-none">
                  <ConfirmMatchButton
                    episodeId={id}
                    videoId={candidate.video.id}
                    strong={candidate.confidence === "strong" && !result.ambiguous}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        eyebrow="Manual"
        title="Enter a video ID"
        actions={<span className="mono">for when matching is uncertain</span>}
      >
        <ManualLinkForm episodeId={id} />
      </Panel>
    </div>
  );
}
