import Link from "next/link";
import { requireUser } from "@/lib/auth/require";
import { can } from "@/lib/auth/authorize";
import { listIntegrations } from "@/lib/integrations/credentials";
import { SCOPE_RATIONALE, YOUTUBE_SCOPES } from "@/lib/integrations/youtube/scopes";
import type { IntegrationProvider } from "@/db/schema";
import { relative, stamp } from "@/lib/format";
import { Panel, StateBadge } from "@/components/ui";
import {
  ConnectBuzzsproutForm,
  ConnectRumbleForm,
  DisconnectButton,
  HealthCheckButton,
  PollRumbleButton,
  SyncBuzzsproutButton,
} from "./parts";

export const dynamic = "force-dynamic";

/**
 * Two of these providers are real in Phase 2. The rest still describe what the
 * capability audit established, with no connect button — a control that does
 * nothing is worse than no control.
 */
const PENDING = [
  {
    name: "Buzzsprout",
    capability: "Episode create/update · audio · artwork · show notes",
    maturity: "Medium",
    detail:
      "Token auth, documented episode endpoints. Future-dated published_at is the scheduling mechanism; that behaviour still needs one live confirmation.",
  },
  {
    name: "Mailchimp",
    capability: "Campaign draft · content · schedule · audience",
    maturity: "High",
    detail:
      "Already proven end to end in the prior Prather Brief app: POST /campaigns then PUT content then schedule. Audience 6f7bc677e9.",
  },
  {
    name: "WordPress",
    capability: "Interim publication target via REST",
    maturity: "High",
    detail:
      "jeffreyprather.com keeps serving the public site. The Studio will push posts to it like any other platform, then retire it as a target.",
  },
  {
    name: "OpusClip",
    capability: "Submit source video · retrieve scored clips · webhooks",
    maturity: "Medium",
    detail:
      "Bearer auth, webhook on completion, 30 req/min. Requires a Pro (Beta), Max or Business plan — the account's plan has not been confirmed.",
  },
  {
    name: "Locals",
    capability: "Manual publishing until API capability exists",
    maturity: "None",
    detail:
      "No public creator API found. The adapter will render a copy-ready post and mark the publication AWAITING_MANUAL so the handoff is tracked.",
  },
  {
    name: "StreamYard",
    capability: "No public production API · external/manual ingest",
    maturity: "None",
    detail:
      "Officially confirmed: no open API. Its Zapier app exposes webinar-registrant events only. The master recording enters the system by hand.",
  },
] as const;

const MATURITY_TONE: Record<string, string> = {
  High: "text-[var(--color-signal-green)]",
  Medium: "text-[var(--color-signal-amber)]",
  Low: "text-[var(--color-signal-red)]",
  None: "text-[var(--color-type-lo)]",
};

const HEALTH_TONE = {
  CONNECTED: "done",
  ATTENTION: "problem",
  DISCONNECTED: "muted",
} as const;

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const [{ error, ok }, user, integrations] = await Promise.all([
    searchParams,
    requireUser(),
    listIntegrations(),
  ]);

  const byProvider = new Map(integrations.map((i) => [i.provider, i]));
  const youtube = byProvider.get("YOUTUBE" as IntegrationProvider);
  const rumble = byProvider.get("RUMBLE" as IntegrationProvider);
  const buzzsprout = byProvider.get("BUZZSPROUT" as IntegrationProvider);
  const canConfigure = can(user.role, "integration.configure");

  const rumbleObservation = rumble?.lastObservation as
    | {
        liveNow?: { title: string; watchingNow: number | null } | null;
        followers?: number | null;
        followersTotal?: number | null;
        subscribers?: number | null;
      }
    | null
    | undefined;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="eyebrow">Connections</div>
          <h1 className="display text-[26px]">Integrations</h1>
        </div>
        {canConfigure && <HealthCheckButton />}
      </div>

      {error && (
        <div className="panel px-4 py-3 border-l-2 border-l-[var(--color-signal-red)]">
          <p className="text-[13px] text-[var(--color-signal-red)]">{error}</p>
        </div>
      )}
      {ok && (
        <div className="panel px-4 py-3 border-l-2 border-l-[var(--color-signal-green)]">
          <p className="text-[13px] text-[var(--color-signal-green)]">{ok}</p>
        </div>
      )}

      {/* ------------------------------------------------------- YOUTUBE */}
      <Panel
        eyebrow="YouTube"
        title="Publishing · metadata · thumbnails · captions · analytics"
        actions={
          <StateBadge
            tone={HEALTH_TONE[youtube?.health ?? "DISCONNECTED"]}
            label={youtube?.health ?? "Not connected"}
          />
        }
      >
        <div className="p-4 space-y-4">
          {youtube ? (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <div className="eyebrow mb-1">Channel</div>
                  <div className="text-[14px] font-semibold">
                    {youtube.accountLabel ?? "—"}
                  </div>
                </div>
                <div>
                  <div className="eyebrow mb-1">Channel ID</div>
                  <div className="mono break-all">{youtube.accountExternalId ?? "—"}</div>
                </div>
                <div>
                  <div className="eyebrow mb-1">Token</div>
                  <div className="mono">
                    {youtube.expiresAt
                      ? youtube.expiresAt.getTime() > Date.now()
                        ? `refreshes ${relative(youtube.expiresAt)}`
                        : "expired — refreshes on next use"
                      : "—"}
                  </div>
                </div>
              </div>

              <div>
                <div className="eyebrow mb-1.5">Granted scopes</div>
                <ul className="space-y-1">
                  {youtube.scopes.map((scope) => (
                    <li key={scope} className="text-[11px] leading-snug">
                      <span className="mono text-[var(--color-signal-blue)]">
                        {scope.replace("https://www.googleapis.com/auth/", "")}
                      </span>
                      {SCOPE_RATIONALE[scope] && (
                        <span className="text-[var(--color-type-lo)]">
                          {" "}
                          — {SCOPE_RATIONALE[scope]}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex items-center gap-4 flex-wrap">
                <span className="mono">
                  last verified {youtube.lastSuccessAt ? relative(youtube.lastSuccessAt) : "never"}
                </span>
                {canConfigure && <DisconnectButton provider="YOUTUBE" />}
              </div>

              {youtube.lastError && (
                <p className="text-[12px] text-[var(--color-signal-red)]">{youtube.lastError}</p>
              )}
            </>
          ) : (
            <>
              <p className="text-[13px] leading-relaxed text-[var(--color-type-mid)]">
                Connect the Google account that owns the channel. The Studio requests
                exactly two scopes:
              </p>
              <ul className="space-y-1.5">
                {YOUTUBE_SCOPES.map((scope) => (
                  <li key={scope} className="text-[12px] leading-snug">
                    <span className="mono text-[var(--color-signal-blue)]">
                      {scope.replace("https://www.googleapis.com/auth/", "")}
                    </span>
                    <span className="text-[var(--color-type-lo)]">
                      {" "}
                      — {SCOPE_RATIONALE[scope]}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-[var(--color-type-lo)] leading-snug">
                Upload permission is deliberately <strong>not</strong> requested. Phase 2 updates
                the existing video and never creates a second copy of a show.
              </p>
              {canConfigure ? (
                <a href="/api/integrations/youtube/start" className="btn btn-primary btn-xs">
                  Connect YouTube
                </a>
              ) : (
                <p className="text-[11px] text-[var(--color-type-lo)]">
                  Only an OWNER can connect integrations.
                </p>
              )}
            </>
          )}
        </div>
      </Panel>

      {/* -------------------------------------------------------- RUMBLE */}
      <Panel
        eyebrow="Rumble"
        title="Live observation only — no upload, no metadata write"
        actions={
          <div className="flex items-center gap-2">
            {rumble && canConfigure && <PollRumbleButton />}
            <StateBadge
              tone={HEALTH_TONE[rumble?.health ?? "DISCONNECTED"]}
              label={rumble?.health ?? "Not connected"}
            />
          </div>
        }
      >
        <div className="p-4 space-y-4">
          <p className="text-[12px] text-[var(--color-type-lo)] leading-relaxed">
            Rumble exposes a poll-only Live Stream API. There is no VOD listing, no media
            retrieval, no metadata write and no webhook. The Studio therefore{" "}
            <strong className="text-[var(--color-type-mid)]">watches</strong> Rumble and never
            drives it — every state it sets is recorded as observed.
          </p>

          {rumble ? (
            <>
              <div className="grid gap-4 sm:grid-cols-4">
                <div>
                  <div className="eyebrow mb-1">Live now</div>
                  <div className="text-[13px] font-semibold">
                    {rumbleObservation?.liveNow ? (
                      <span className="text-[var(--color-signal-red)]">
                        {rumbleObservation.liveNow.title}
                      </span>
                    ) : (
                      <span className="text-[var(--color-type-lo)]">Nothing live</span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="eyebrow mb-1">Watching</div>
                  <div className="mono">{rumbleObservation?.liveNow?.watchingNow ?? "—"}</div>
                </div>
                <div>
                  <div className="eyebrow mb-1">Followers</div>
                  <div className="mono">
                    {rumbleObservation?.followersTotal?.toLocaleString() ??
                      rumbleObservation?.followers?.toLocaleString() ??
                      "—"}
                  </div>
                </div>
                <div>
                  <div className="eyebrow mb-1">Last poll</div>
                  <div className="mono">
                    {rumble.lastObservedAt ? relative(rumble.lastObservedAt) : "never"}
                  </div>
                </div>
              </div>

              {rumble.lastError && (
                <p className="text-[12px] text-[var(--color-signal-red)]">{rumble.lastError}</p>
              )}
              {canConfigure && <DisconnectButton provider="RUMBLE" />}
            </>
          ) : canConfigure ? (
            <ConnectRumbleForm />
          ) : (
            <p className="text-[11px] text-[var(--color-type-lo)]">
              Only an OWNER can connect integrations.
            </p>
          )}
        </div>
      </Panel>

      {/* ---------------------------------------------------- BUZZSPROUT */}
      <Panel
        eyebrow="Buzzsprout"
        title="The podcast — read first, write only what a human approved"
        actions={
          <div className="flex items-center gap-2">
            {buzzsprout && canConfigure && <SyncBuzzsproutButton />}
            <StateBadge
              tone={HEALTH_TONE[buzzsprout?.health ?? "DISCONNECTED"]}
              label={buzzsprout?.health ?? "Not connected"}
            />
          </div>
        }
      >
        <div className="p-4 space-y-4">
          <p className="text-[12px] text-[var(--color-type-lo)] leading-relaxed">
            Buzzsprout documents GET, POST and PUT for episodes — there is{" "}
            <strong className="text-[var(--color-type-mid)]">no DELETE and no PATCH</strong>, so
            anything created here cannot be cleanly removed. The Studio reads before it writes,
            merges onto the current remote state rather than assuming which fields survive an
            update, and never creates an episode without real audio.
          </p>

          {buzzsprout ? (
            <>
              <div className="grid gap-4 sm:grid-cols-4">
                <div>
                  <div className="eyebrow mb-1">Podcast</div>
                  <div className="text-[13px] font-semibold">
                    {buzzsprout.accountLabel ?? "—"}
                  </div>
                </div>
                <div>
                  <div className="eyebrow mb-1">Podcast ID</div>
                  <div className="mono">{buzzsprout.accountExternalId ?? "—"}</div>
                </div>
                <div>
                  <div className="eyebrow mb-1">Last sync</div>
                  <div className="mono">
                    {buzzsprout.lastSuccessAt ? relative(buzzsprout.lastSuccessAt) : "never"}
                  </div>
                </div>
                <div>
                  <div className="eyebrow mb-1">Episodes seen</div>
                  <div className="mono">
                    {(buzzsprout.lastObservation as { episodeCount?: number } | null)
                      ?.episodeCount ?? "—"}
                  </div>
                </div>
              </div>

              {buzzsprout.lastError && (
                <p className="text-[12px] text-[var(--color-signal-red)]">
                  {buzzsprout.lastError}
                </p>
              )}
              {canConfigure && <DisconnectButton provider="BUZZSPROUT" />}
            </>
          ) : canConfigure ? (
            <ConnectBuzzsproutForm />
          ) : (
            <p className="text-[11px] text-[var(--color-type-lo)]">
              Only an OWNER can connect integrations.
            </p>
          )}
        </div>
      </Panel>

      {/* ------------------------------------------------------- PENDING */}
      <div className="panel px-4 py-3 border-l-2 border-l-[var(--color-signal-amber)]">
        <p className="text-[13px] leading-relaxed">
          <strong className="text-[var(--color-signal-amber)]">
            The providers below are not connected in this phase.
          </strong>{" "}
          No SDK is installed and no credential is stored for any of them. What is recorded here
          is what the capability audit established, so the adapters get built against reality.
        </p>
      </div>

      <div className="grid gap-px bg-[var(--color-ink-200)] border border-[var(--color-ink-200)] md:grid-cols-2">
        {PENDING.map((p) => (
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

      <p className="mono text-[10px]">
        Credentials are encrypted with AES-256-GCM before storage. No token is ever rendered,
        logged, or sent to the browser. Last page load {stamp(new Date())}.
      </p>

      <Link href="/studio/jobs" className="btn btn-ghost btn-xs">
        See integration jobs
      </Link>
    </div>
  );
}
