import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { settings, shows, sponsors, users } from "@/db/schema";
import { requireUser } from "@/lib/auth/require";
import { can } from "@/lib/auth/authorize";
import { Empty, Field, Panel } from "@/components/ui";
import { DEFAULT_SEND_TIME, DEFAULT_SEND_ZONE } from "@/lib/email/send-time";
import { SponsorManager } from "./sponsors";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();
  const [show] = await db.select().from(shows).limit(1);
  const [config] = await db.select().from(settings).where(eq(settings.id, "global"));
  const sponsorRows = show
    ? await db
        .select()
        .from(sponsors)
        .where(eq(sponsors.showId, show.id))
        .orderBy(asc(sponsors.sortOrder))
    : [];
  const canManageUsers = can(user.role, "user.manage");
  const teamRows = canManageUsers ? await db.select().from(users) : [];

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow">Configuration</div>
        <h1 className="display text-[26px]">Settings</h1>
      </div>

      <p className="text-[12px] text-[var(--color-type-lo)] max-w-[760px] leading-relaxed">
        These are the operating defaults every platform description and campaign will
        compose from. They live in the database rather than in code, so they can change
        without a deploy. Sponsors are editable here, by the owner; the rest is still
        read-only.
      </p>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel eyebrow="Show" title={show?.name ?? "—"}>
          <div className="p-4 grid gap-4 sm:grid-cols-2">
            <Field label="Slug" value={<span className="mono">{show?.slug}</span>} />
            <Field label="Tagline" value={show?.tagline ?? "—"} />
            <Field
              label="Default start"
              value={`${show?.defaultStartTime} ${show?.timezone}`}
            />
            <Field label="Cadence" value={show?.cadenceNote ?? "—"} />
            <Field label="Title prefix" value={show?.titlePrefix ?? "—"} />
            <Field label="Brief label" value={show?.briefLabel ?? "—"} />
            <div className="sm:col-span-2">
              <Field label="Credential line" value={show?.credentialLine ?? "—"} />
            </div>
          </div>
        </Panel>

        <Panel eyebrow="Publishing defaults" title="CTA &amp; destinations">
          <div className="p-4 grid gap-4 sm:grid-cols-2">
            <Field label="From name" value={config?.fromName ?? "—"} />
            <Field label="Reply-to" value={config?.replyTo ?? "—"} />
            <Field
              label="Patreon"
              value={
                config?.patreonUrl ? (
                  <a href={config.patreonUrl} className="link mono" target="_blank" rel="noreferrer">
                    {config.patreonUrl}
                  </a>
                ) : (
                  "—"
                )
              }
            />
            <Field
              label="Mailchimp audience"
              value={<span className="mono">{config?.mailchimpAudienceId ?? "—"}</span>}
            />
            <Field
              label="Briefing send time"
              value={
                <span className="mono">
                  {config?.emailSendTime ?? DEFAULT_SEND_TIME}{" "}
                  {config?.emailSendTimezone ?? DEFAULT_SEND_ZONE}
                </span>
              }
            />
            <div className="sm:col-span-2">
              <Field label="Default CTA" value={config?.defaultCta ?? "—"} />
            </div>
          </div>
        </Panel>
      </div>

      <Panel
        eyebrow="Sponsors"
        title={`${sponsorRows.filter((s) => s.active).length} of ${sponsorRows.length} in the briefing`}
      >
        <SponsorManager
          canEdit={can(user.role, "settings.edit")}
          sponsors={sponsorRows.map((s) => ({
            id: s.id,
            name: s.name,
            url: s.url,
            offer: s.offer,
            active: s.active,
          }))}
        />
      </Panel>

      <Panel
        eyebrow="AI voice profile"
        title="Jeff's writing samples"
        actions={<span className="mono">nothing reads this yet</span>}
      >
        <div className="p-4">
          <p className="text-[12px] text-[var(--color-type-lo)] mb-3 leading-relaxed">
            Carried over verbatim from the prior Prather Brief app. The content engine
            that uses it arrives in a later phase; it lives here so it can grow without a
            code change.
          </p>
          <pre className="whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--color-type-mid)] bg-[var(--color-ink-000)] border border-[var(--color-ink-200)] p-3 max-h-[280px] overflow-y-auto">
{config?.aiVoiceProfile ?? "—"}
          </pre>
          {config?.aiVoiceNotes && (
            <p className="text-[12px] text-[var(--color-type-mid)] mt-3">
              <span className="eyebrow">Notes </span>
              {config.aiVoiceNotes}
            </p>
          )}
        </div>
      </Panel>

      {canManageUsers && (
        <Panel eyebrow="Team" title="Users &amp; roles">
          <div className="overflow-x-auto">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {teamRows.map((u) => (
                <tr key={u.id}>
                  <td className="font-semibold">{u.name}</td>
                  <td className="mono">{u.email}</td>
                  <td>
                    <span className="tag">{u.role}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
