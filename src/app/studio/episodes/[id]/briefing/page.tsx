import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodeContentDrafts, episodes, settings } from "@/db/schema";
import { requireUser } from "@/lib/auth/require";
import { can } from "@/lib/auth/authorize";
import { previewBriefing, BriefingNotReadyError } from "@/lib/domain/briefing-campaign";
import { topicLines } from "@/lib/domain/intake";
import { BackToEpisode, Empty, Panel, StateBadge } from "@/components/ui";
import { ScheduleBriefingForm } from "./parts";

export const dynamic = "force-dynamic";

/**
 * Review the briefing before it is scheduled.
 *
 * ## Why the real HTML is rendered here
 *
 * Reviewing a description of an email is not reviewing the email. The iframe
 * below holds exactly the markup that gets uploaded to Mailchimp — same
 * tables, same inline styles, same font stack — so what is approved is what
 * goes out. It is sandboxed because email HTML is not trusted markup.
 *
 * ## Why Jeff's original sits beside the generated copy
 *
 * The editorial rule is that Jeff is PROOFREAD, NOT REWRITTEN. That rule is
 * unenforceable if the original is not visible at the moment of the decision:
 * a generated paragraph reads perfectly well on its own, and the only way to
 * see what was lost is to see what was there. So both are shown, side by side,
 * and swapping to his is one click rather than a trip to the database.
 */
export default async function BriefingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();
  const canSchedule = can(user.role, "publication.enqueue");

  const [episode] = await db.select().from(episodes).where(eq(episodes.id, id)).limit(1);
  if (!episode) notFound();

  let preview;
  let fatal: string | null = null;
  try {
    preview = await previewBriefing(id);
  } catch (error) {
    if (error instanceof BriefingNotReadyError) {
      fatal = error.message;
    } else {
      throw error;
    }
  }

  const [config] = await db.select().from(settings).where(eq(settings.id, "global")).limit(1);

  const drafts = await db
    .select()
    .from(episodeContentDrafts)
    .where(
      and(
        eq(episodeContentDrafts.episodeId, id),
        eq(episodeContentDrafts.field, "email_brief"),
      ),
    )
    .orderBy(asc(episodeContentDrafts.sortOrder));

  const generatedBrief = drafts.find((d) => d.state === "APPROVED")?.value
    ?? drafts.find((d) => d.state === "PROPOSED")?.value
    ?? null;

  const hostTopics = topicLines(episode.hostTopics);

  if (fatal || !preview) {
    return (
      <div className="stack">
        <BackToEpisode episodeId={id} />
        <Panel eyebrow="Briefing" title="Not ready">
          <Empty>{fatal ?? "This briefing could not be assembled."}</Empty>
        </Panel>
      </div>
    );
  }

  const blocked = preview.blockers.length > 0;

  return (
    <div className="stack">
      <BackToEpisode episodeId={id} />

      {/* The send time is the headline fact of this page, so it is stated
          first and in full — clock time, zone, and what that means relative
          to the broadcast today. The last clause is the one that changes by
          itself in November. */}
      <Panel
        eyebrow="Briefing"
        title="Review before it is scheduled"
        actions={
          <StateBadge
            tone={blocked ? "waiting" : "ready"}
            label={blocked ? `${preview.blockers.length} to resolve` : "Ready"}
          />
        }
      >
        <div className="p-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[var(--color-ink-200)]">
          <span className="eyebrow">Sends</span>
          <span className="text-[18px] font-semibold tracking-tight">
            {preview.sendTime.label}
          </span>
          <span className="text-[12px] text-[var(--color-type-lo)]">
            {preview.sendSummary.split(" — ")[1]}
          </span>
          <span className="mono text-[11px] text-[var(--color-type-lo)] ml-auto">
            {preview.sendTime.wallTime} {preview.sendTime.zone}
          </span>
        </div>

        {blocked && (
          <ul className="px-4 py-3 space-y-1.5 border-b border-[var(--color-ink-200)]">
            {preview.blockers.map((b) => (
              <li
                key={b}
                className="text-[12px] text-[var(--color-signal-amber)] leading-snug"
              >
                · {b}
              </li>
            ))}
          </ul>
        )}

        <div className="p-4">
          {canSchedule ? (
            <ScheduleBriefingForm
              episodeId={id}
              sendSummary={preview.sendTime.label}
              audienceLabel={
                config?.mailchimpAudienceId
                  ? "the Mailchimp audience configured in Settings"
                  : "your Mailchimp audience"
              }
              disabled={blocked}
            />
          ) : (
            <p className="text-[12px] text-[var(--color-type-lo)]">
              You do not have permission to schedule sends.
            </p>
          )}
        </div>
      </Panel>

      {/* --------------------------------------------- Jeff vs the engine */}
      <Panel eyebrow="Editorial" title="Jeff&rsquo;s words and the proofread">
        <p className="px-4 py-2.5 text-[12px] text-[var(--color-type-lo)] leading-relaxed border-b border-[var(--color-ink-200)]">
          <strong className="text-[var(--color-type-mid)]">
            Jeff is proofread, not rewritten.
          </strong>{" "}
          The engine corrects spelling and grammar and keeps his phrasing. If the
          generated column has smoothed his voice, approve his original instead — both
          are kept, and neither is discarded.
        </p>
        <div className="grid gap-px bg-[var(--color-ink-200)] md:grid-cols-2">
          <div className="bg-[var(--color-ink-100)] p-3">
            <div className="eyebrow mb-2">What Jeff submitted</div>
            {episode.hostBrief ? (
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed">
                {episode.hostBrief}
              </p>
            ) : (
              <p className="text-[12px] text-[var(--color-type-lo)]">
                He did not supply a write-up for this show. The brief was built from his
                topics.
              </p>
            )}
          </div>
          <div className="bg-[var(--color-ink-100)] p-3">
            <div className="eyebrow mb-2">In the email</div>
            {generatedBrief ? (
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed">
                {generatedBrief}
              </p>
            ) : (
              <p className="text-[12px] text-[var(--color-type-lo)]">
                Nothing generated yet. Run the email copy step on the episode.
              </p>
            )}
          </div>
        </div>

        {hostTopics.length > 0 && (
          <div className="px-4 py-3 border-t border-[var(--color-ink-200)]">
            <div className="eyebrow mb-2">
              His topics — {hostTopics.length} submitted, {preview.email.bullets.length} in
              the email
            </div>
            {hostTopics.length !== preview.email.bullets.length && (
              <p className="text-[12px] text-[var(--color-signal-amber)] mb-2 leading-snug">
                The counts differ. His topics are passed through, not edited down — check
                nothing was dropped.
              </p>
            )}
            <ul className="space-y-1">
              {preview.email.bullets.map((b, i) => (
                <li key={i} className="text-[12px] leading-snug">
                  · {b}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      {/* ------------------------------------------------- the actual email */}
      <Panel
        eyebrow="Preview"
        title="The email itself"
        actions={<span className="mono">{preview.email.sponsors.length} sponsors</span>}
      >
        <div className="p-4 bg-[var(--color-ink-100)]">
          <iframe
            title="Briefing preview"
            srcDoc={preview.html}
            sandbox=""
            className="w-full h-[760px] bg-white border border-[var(--color-ink-200)]"
          />
        </div>
        <details className="border-t border-[var(--color-ink-200)]">
          <summary className="px-4 py-2.5 text-[12px] cursor-pointer text-[var(--color-type-lo)]">
            Plain-text version
          </summary>
          <pre className="px-4 pb-4 whitespace-pre-wrap text-[12px] leading-relaxed">
            {preview.text}
          </pre>
        </details>
      </Panel>
    </div>
  );
}
