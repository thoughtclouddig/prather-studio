import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodes } from "@/db/schema";
import { requireUser } from "@/lib/auth/require";
import { planYouTubeUpdate } from "@/lib/domain/youtube-publish";
import { relative } from "@/lib/format";
import { Panel } from "@/components/ui";
import { ConfirmUpdateForm } from "./parts";

export const dynamic = "force-dynamic";

/** Line-level diff, so a description change shows what actually moved. */
function DiffView({ current, proposed }: { current: string; proposed: string }) {
  const before = current.split("\n");
  const after = proposed.split("\n");
  const beforeSet = new Set(before);
  const afterSet = new Set(after);

  return (
    <div className="grid gap-px bg-[var(--color-ink-200)] md:grid-cols-2 border border-[var(--color-ink-200)]">
      <div className="bg-[var(--color-ink-100)] p-3">
        <div className="eyebrow mb-2">Current on YouTube</div>
        <pre className="whitespace-pre-wrap text-[12px] leading-relaxed">
          {before.map((line, i) => (
            <div
              key={i}
              className={
                afterSet.has(line)
                  ? "text-[var(--color-type-mid)]"
                  : "bg-[#261417] text-[#e8798a]"
              }
            >
              {line || " "}
            </div>
          ))}
        </pre>
      </div>
      <div className="bg-[var(--color-ink-100)] p-3">
        <div className="eyebrow mb-2">Approved — will replace it</div>
        <pre className="whitespace-pre-wrap text-[12px] leading-relaxed">
          {after.map((line, i) => (
            <div
              key={i}
              className={
                beforeSet.has(line)
                  ? "text-[var(--color-type-mid)]"
                  : "bg-[#0d1512] text-[#6fd39c]"
              }
            >
              {line || " "}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

export default async function YouTubeUpdatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireUser();

  const [episode] = await db.select().from(episodes).where(eq(episodes.id, id)).limit(1);
  if (!episode) notFound();

  let plan: Awaited<ReturnType<typeof planYouTubeUpdate>> | null = null;
  let planError: string | null = null;
  try {
    plan = await planYouTubeUpdate(id);
  } catch (error) {
    planError = error instanceof Error ? error.message : String(error);
  }

  const changed = plan?.changes.filter((c) => c.changed) ?? [];

  return (
    <div className="space-y-5 max-w-[1100px]">
      <div>
        <div className="eyebrow">
          <Link href={`/studio/episodes/${id}`} className="hover:text-[var(--color-type-hi)]">
            {episode.approvedTitle ?? episode.workingTitle}
          </Link>
          {" / YouTube"}
        </div>
        <h1 className="display text-[24px] mt-1">Update the existing video</h1>
        {plan && (
          <p className="mono mt-1.5">
            <a
              href={`https://www.youtube.com/watch?v=${plan.videoId}`}
              target="_blank"
              rel="noreferrer noopener"
              className="link"
            >
              {plan.videoId}
            </a>{" "}
            · read from YouTube just now
          </p>
        )}
      </div>

      {planError && (
        <div className="panel px-4 py-3 border-l-2 border-l-[var(--color-signal-red)]">
          <p className="text-[13px] text-[var(--color-signal-red)]">{planError}</p>
        </div>
      )}

      {plan && plan.missing.length > 0 && (
        <div className="panel px-4 py-3 border-l-2 border-l-[var(--color-signal-amber)]">
          <p className="text-[13px]">
            <strong className="text-[var(--color-signal-amber)]">Not ready.</strong> This episode
            still needs {plan.missing.join(" and ")}.{" "}
            <Link href={`/studio/episodes/${id}/review`} className="link">
              Approve it in Review
            </Link>
            . Proposed content cannot be sent.
          </p>
        </div>
      )}

      {plan && plan.remoteDrift && (
        <div className="panel px-4 py-3 border-l-2 border-l-[var(--color-signal-amber)]">
          <p className="text-[13px]">
            <strong className="text-[var(--color-signal-amber)]">
              This video changed outside the Studio.
            </strong>{" "}
            The {plan.remoteDrift.fields.join(" and ")} differ from what we recorded
            {plan.remoteDrift.since ? ` ${relative(plan.remoteDrift.since)}` : ""}. The current
            remote value is shown on the left — it is what your update would replace.
          </p>
        </div>
      )}

      {plan && !plan.hasChanges && plan.missing.length === 0 && (
        <div className="panel px-4 py-3 border-l-2 border-l-[var(--color-signal-green)]">
          <p className="text-[13px] text-[var(--color-signal-green)]">
            YouTube already matches the approved metadata. Nothing to send.
          </p>
        </div>
      )}

      {plan?.changes.map((change) => (
        <Panel
          key={change.field}
          eyebrow={change.field}
          title={change.changed ? "Will change" : "Unchanged"}
          actions={
            <span className={`state state-${change.changed ? "waiting" : "muted"}`}>
              {change.changed ? "Differs" : "Same"}
            </span>
          }
        >
          {change.field === "title" ? (
            <div className="grid gap-px bg-[var(--color-ink-200)] md:grid-cols-2 border-t border-[var(--color-ink-200)]">
              <div className="bg-[var(--color-ink-100)] p-4">
                <div className="eyebrow mb-2">Current on YouTube</div>
                <div className="text-[15px]">{change.current}</div>
              </div>
              <div className="bg-[var(--color-ink-100)] p-4">
                <div className="eyebrow mb-2">Approved</div>
                <div
                  className={`text-[15px] ${change.changed ? "text-[#6fd39c]" : "text-[var(--color-type-mid)]"}`}
                >
                  {change.proposed}
                </div>
                <div className="mono mt-2">{change.proposed.length}/100 characters</div>
              </div>
            </div>
          ) : (
            <div className="p-2">
              <DiffView current={change.current} proposed={change.proposed} />
            </div>
          )}
        </Panel>
      ))}

      {plan && plan.hasChanges && plan.missing.length === 0 && (
        <Panel eyebrow="Confirm" title="This writes to the live channel">
          <ConfirmUpdateForm
            episodeId={id}
            fingerprint={plan.remoteFingerprint}
            driftFields={plan.remoteDrift?.fields ?? []}
            changedFields={changed.map((c) => c.field)}
          />
        </Panel>
      )}

      <p className="mono text-[10px] leading-relaxed">
        The full snippet is submitted on every update — videos.update deletes any property of a
        part that a request omits, so sending only the title and description would wipe the
        video&rsquo;s tags and category. Existing tags and category are read back and preserved.
      </p>
    </div>
  );
}
