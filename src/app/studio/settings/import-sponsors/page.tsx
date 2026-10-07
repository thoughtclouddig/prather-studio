import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { shows, sponsors } from "@/db/schema";
import { requireUser } from "@/lib/auth/require";
import { can } from "@/lib/auth/authorize";
import { Empty, Panel, StateBadge } from "@/components/ui";
import {
  getCampaignContent,
  listCampaigns,
  MailchimpNotConnectedError,
} from "@/lib/integrations/mailchimp/client";
import { extractSponsors } from "@/lib/domain/sponsor-import";
import { CandidateReview } from "./parts";

export const dynamic = "force-dynamic";

/**
 * Import the standing sponsors from a briefing that already went out.
 *
 * The sponsors were never in a database — they live in the sent emails, which
 * makes Mailchimp the system of record for them until this runs once.
 */
export default async function ImportSponsorsPage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string }>;
}) {
  const { campaign } = await searchParams;
  const user = await requireUser();

  if (!can(user.role, "settings.edit")) {
    return (
      <div className="stack">
        <Panel eyebrow="Sponsors" title="Import from a previous briefing">
          <Empty>Only the owner can change publishing defaults.</Empty>
        </Panel>
      </div>
    );
  }

  const [show] = await db.select().from(shows).limit(1);
  const existing = show
    ? await db.select().from(sponsors).where(eq(sponsors.showId, show.id))
    : [];

  let campaigns;
  let connectionError: string | null = null;
  try {
    campaigns = await listCampaigns(20);
  } catch (error) {
    connectionError =
      error instanceof MailchimpNotConnectedError
        ? "Mailchimp is not connected. Add the API key in Integrations first."
        : error instanceof Error
          ? error.message
          : String(error);
  }

  const candidates = campaign
    ? await (async () => {
        const content = await getCampaignContent(campaign);
        return extractSponsors(content.html, content.plainText);
      })()
    : null;

  return (
    <div className="stack">
      <Link href="/studio/settings" className="link text-[12px]">
        &larr; Settings
      </Link>

      <Panel
        eyebrow="Sponsors"
        title="Import from a previous briefing"
        actions={<span className="mono">{existing.length} already configured</span>}
      >
        <p className="px-4 py-2.5 text-[12px] text-[var(--color-type-lo)] leading-relaxed border-b border-[var(--color-ink-200)]">
          The sponsors and their promo codes only exist in the emails that have already
          gone out. Pick one that carried the full list and the Studio will read them
          back &mdash; then you check them before anything is saved.
        </p>

        {connectionError ? (
          <Empty>{connectionError}</Empty>
        ) : campaigns && campaigns.length === 0 ? (
          <Empty>Mailchimp has no campaigns on this account yet.</Empty>
        ) : (
          <table className="grid-table">
            <tbody>
              {(campaigns ?? []).map((c) => (
                <tr key={c.id}>
                  <td className="align-top">
                    <div className="text-[13px] font-semibold">
                      {c.subject || c.title || "(untitled)"}
                    </div>
                    <div className="text-[11px] text-[var(--color-type-lo)] mono mt-0.5">
                      {c.sentAt ? new Date(c.sentAt).toLocaleDateString() : "not sent"} ·{" "}
                      {c.status}
                    </div>
                  </td>
                  <td className="w-[150px] align-top text-right">
                    <Link
                      href={`/studio/settings/import-sponsors?campaign=${c.id}`}
                      className={`btn btn-xs ${campaign === c.id ? "btn-primary" : ""}`}
                    >
                      {campaign === c.id ? "Reading" : "Read this one"}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {candidates && (
        <Panel
          eyebrow="Review"
          title="What it found"
          actions={
            <StateBadge
              tone={candidates.length > 0 ? "ready" : "muted"}
              label={`${candidates.length} candidate${candidates.length === 1 ? "" : "s"}`}
            />
          }
        >
          {candidates.length === 0 ? (
            <Empty>
              Nothing in that campaign looked like a sponsor. Try one that carried the
              full sponsor block.
            </Empty>
          ) : (
            <>
              <p className="px-4 py-2.5 text-[12px] text-[var(--color-type-lo)] leading-relaxed border-b border-[var(--color-ink-200)]">
                Ones carrying a promo code are ticked. The rest are links that were not
                obviously a platform or a social account &mdash; they may well be
                nothing. <strong className="text-[var(--color-type-mid)]">Untick
                anything that is not a sponsor</strong> before adding.
              </p>
              <CandidateReview
                candidates={candidates}
                existingNames={existing.map((s) => s.name)}
              />
            </>
          )}
        </Panel>
      )}
    </div>
  );
}
