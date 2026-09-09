import { Panel } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Integrations.
 *
 * Nothing is connected, and there are deliberately NO connect buttons — a
 * control that does nothing is worse than no control. Each row states what the
 * Phase 0 capability audit actually established, so the page is useful now and
 * becomes the real connection surface later.
 */
const PROVIDERS = [
  {
    name: "YouTube",
    capability: "Publishing · metadata · thumbnails · captions · analytics",
    maturity: "High",
    detail:
      "Full Data + Analytics API. Owner OAuth also makes captions.download usable, which is the transcript path. Scope set still needs a live test — captions may require youtube.force-ssl rather than the narrower scopes.",
  },
  {
    name: "Rumble",
    capability: "Live observation · upload pending account capability",
    maturity: "Low",
    detail:
      "Self-serve Live Stream API is poll-only and gives is_live, video id, viewer counts and chat. There is no VOD listing, no media retrieval, no metadata write and no webhooks. Upload requires a token granted by Rumble BD.",
  },
  {
    name: "Buzzsprout",
    capability: "Episode create/update · audio · artwork · show notes",
    maturity: "Medium",
    detail:
      "Token auth, documented episode endpoints. Future-dated published_at is the scheduling mechanism; that behaviour still needs one live confirmation. No webhooks.",
  },
  {
    name: "Mailchimp",
    capability: "Campaign draft · content · schedule · audience",
    maturity: "High",
    detail:
      "The only integration already proven end to end, in the prior Prather Brief app: POST /campaigns → PUT content → schedule. Audience 6f7bc677e9.",
  },
  {
    name: "WordPress",
    capability: "Interim publication target via REST",
    maturity: "High",
    detail:
      "jeffreyprather.com keeps serving the public site while the Studio is built. The Studio will push posts to it like any other platform, then be retired as a target when the new public site ships.",
  },
  {
    name: "OpusClip",
    capability: "Submit source video · retrieve scored clips · webhooks",
    maturity: "Medium",
    detail:
      "Bearer auth, webhook on completion, 30 req/min. Requires a Pro (Beta), Max or Business plan — the account's current plan has not been confirmed.",
  },
  {
    name: "Locals",
    capability: "Manual publishing until API capability exists",
    maturity: "None",
    detail:
      "No public creator API found. The adapter will render a copy-ready post and mark the publication AWAITING_MANUAL so the handoff is tracked rather than forgotten.",
  },
  {
    name: "StreamYard",
    capability: "No public production API · external/manual ingest",
    maturity: "None",
    detail:
      "Officially confirmed: no open API. The Zapier app exposes webinar-registrant events only. The master recording enters the system by hand — that is the one manual step in the workflow.",
  },
] as const;

const MATURITY_TONE: Record<string, string> = {
  High: "text-[var(--color-signal-green)]",
  Medium: "text-[var(--color-signal-amber)]",
  Low: "text-[var(--color-signal-red)]",
  None: "text-[var(--color-type-lo)]",
};

export default function IntegrationsPage() {
  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow">Connections</div>
        <h1 className="display text-[26px]">Integrations</h1>
      </div>

      <div className="panel px-4 py-3 border-l-2 border-l-[var(--color-signal-amber)]">
        <p className="text-[13px] leading-relaxed">
          <strong className="text-[var(--color-signal-amber)]">
            Connection setup arrives in a later phase.
          </strong>{" "}
          No provider SDK is installed and no credential is stored. This page records
          what each platform can actually do, from the Phase 0 capability audit, so the
          adapters get built against reality rather than against assumptions.
        </p>
      </div>

      <div className="grid gap-px bg-[var(--color-ink-200)] border border-[var(--color-ink-200)] md:grid-cols-2">
        {PROVIDERS.map((p) => (
          <article key={p.name} className="bg-[var(--color-ink-100)] p-4">
            <header className="flex items-start justify-between gap-3 mb-2">
              <h2 className="text-[15px] font-bold tracking-tight">{p.name}</h2>
              <span className="state state-muted">Not connected</span>
            </header>
            <p className="text-[12px] text-[var(--color-type-mid)] mb-2">{p.capability}</p>
            <p className="text-[12px] text-[var(--color-type-lo)] leading-relaxed mb-3">
              {p.detail}
            </p>
            <div className="eyebrow">
              API maturity{" "}
              <span className={`${MATURITY_TONE[p.maturity]} font-bold`}>{p.maturity}</span>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
