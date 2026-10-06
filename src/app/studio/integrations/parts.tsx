"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  connectBuzzsproutAction,
  connectMailchimpAction,
  connectPrintfulAction,
  connectRumbleAction,
  connectWordPressAction,
  disconnectIntegrationAction,
  pollRumbleNowAction,
  syncBuzzsproutAction,
  testIntegrationsAction,
} from "@/app/studio/phase2-actions";

function Submit({
  children,
  className = "btn btn-xs",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "…" : children}
    </button>
  );
}

function Feedback({ state }: { state: { ok?: string; error?: string } | undefined }) {
  if (!state) return null;
  if (state.error) {
    return (
      <p className="text-[11px] text-[var(--color-signal-red)] mt-1.5 leading-snug">
        {state.error}
      </p>
    );
  }
  if (state.ok) {
    return (
      <p className="text-[11px] text-[var(--color-signal-green)] mt-1.5 leading-snug">
        {state.ok}
      </p>
    );
  }
  return null;
}

export function DisconnectButton({ provider }: { provider: string }) {
  const [state, action] = useActionState(disconnectIntegrationAction, undefined);
  return (
    <form action={action}>
      <input type="hidden" name="provider" value={provider} />
      <Submit className="btn btn-xs btn-reject">Disconnect</Submit>
      <Feedback state={state} />
    </form>
  );
}

export function HealthCheckButton() {
  const [state, action] = useActionState(testIntegrationsAction, undefined);
  return (
    <form action={action} className="inline-flex flex-col items-end">
      <Submit>Test all connections</Submit>
      <Feedback state={state} />
    </form>
  );
}

export function PollRumbleButton() {
  const [state, action] = useActionState(pollRumbleNowAction, undefined);
  return (
    <form action={action}>
      <Submit>Poll now</Submit>
      <Feedback state={state} />
    </form>
  );
}

/**
 * The Rumble Live Stream API URL is the credential — there is no header auth.
 * It is a password field for that reason, and it is never rendered back.
 */
export function ConnectRumbleForm() {
  const [state, action] = useActionState(connectRumbleAction, undefined);
  return (
    <form action={action} className="space-y-2">
      <label className="block">
        <span className="eyebrow block mb-1.5">Live Stream API URL or key</span>
        <input
          name="apiUrl"
          type="password"
          required
          autoComplete="off"
          placeholder="Paste the whole URL, or just the key"
          className="field font-mono text-[11px]"
        />
      </label>
      <p className="text-[11px] text-[var(--color-type-lo)] leading-snug">
        Generate it at <span className="mono">rumble.com/account/livestream-api</span>. Either
        the full URL or the key alone works — the key encodes your user ID, so the Studio can
        rebuild the URL from it. It is tested before saving, stored encrypted, and never
        displayed again.
      </p>
      <p className="text-[11px] text-[var(--color-type-lo)] leading-snug">
        <strong className="text-[var(--color-signal-amber)]">Not</strong> the RTMP URL or stream
        key from Rumble Studio&rsquo;s streamer configuration — those tell an encoder where to
        push video and return no data.
      </p>
      <Submit className="btn btn-xs btn-primary">Test &amp; connect</Submit>
      <Feedback state={state} />
    </form>
  );
}

/**
 * The Buzzsprout API token.
 *
 * A password field that is never rendered back, submitted to a server action
 * that verifies the token against Buzzsprout before storing it encrypted. The
 * value never reaches a client bundle, a log line or a URL.
 */
export function ConnectBuzzsproutForm() {
  const [state, action] = useActionState(connectBuzzsproutAction, undefined);
  return (
    <form action={action} className="space-y-2">
      <label className="block">
        <span className="eyebrow block mb-1.5">API token</span>
        <input
          name="apiToken"
          type="password"
          required
          autoComplete="off"
          placeholder="Paste the Buzzsprout API token"
          className="field font-mono text-[11px]"
        />
      </label>
      <label className="block">
        <span className="eyebrow block mb-1.5">
          Podcast ID <span className="normal-case tracking-normal">(optional)</span>
        </span>
        <input
          name="podcastId"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="1762960"
          className="field font-mono text-[11px]"
        />
      </label>
      <p className="text-[11px] text-[var(--color-type-lo)] leading-snug">
        Buzzsprout dashboard &rarr; <span className="mono">Settings &rarr; API</span>. The token
        is verified against your account before it is saved, then stored encrypted and never
        displayed again. Leave the podcast ID blank and the Studio will use the one the token
        reaches.
      </p>
      <Submit className="btn btn-xs btn-primary">Verify &amp; connect</Submit>
      <Feedback state={state} />
    </form>
  );
}

export function ConnectWordPressForm() {
  const [state, action] = useActionState(connectWordPressAction, undefined);
  return (
    <form action={action} className="space-y-2">
      <label className="block">
        <span className="eyebrow block mb-1.5">Site address</span>
        <input
          name="siteUrl"
          type="text"
          autoComplete="off"
          defaultValue="https://jeffreyprather.com"
          className="field font-mono text-[11px]"
        />
      </label>
      <label className="block">
        <span className="eyebrow block mb-1.5">WordPress username</span>
        <input
          name="username"
          type="text"
          required
          autoComplete="off"
          placeholder="the account the post is authored by"
          className="field text-[12px]"
        />
      </label>
      <label className="block">
        <span className="eyebrow block mb-1.5">Application password</span>
        <input
          name="applicationPassword"
          type="password"
          required
          autoComplete="off"
          placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
          className="field font-mono text-[11px]"
        />
      </label>
      <p className="text-[11px] text-[var(--color-type-lo)] leading-snug">
        Generate it at <span className="mono">/wp-admin/profile.php</span> &rarr; Application
        Passwords. That is a separate credential from your login and can be revoked on its own.
        It is checked against the site &mdash; including whether the user can upload media
        &mdash; before anything is stored.
      </p>
      <p className="text-[11px] text-[var(--color-type-lo)] leading-snug">
        <strong className="text-[var(--color-signal-amber)]">Not</strong> your WordPress login
        password. Posts are always created as <strong>drafts</strong>; the Studio never
        publishes to the public site.
      </p>
      <Submit className="btn btn-xs btn-primary">Verify &amp; connect</Submit>
      <Feedback state={state} />
    </form>
  );
}

export function ConnectMailchimpForm() {
  const [state, action] = useActionState(connectMailchimpAction, undefined);
  return (
    <form action={action} className="space-y-2">
      <label className="block">
        <span className="eyebrow block mb-1.5">API key</span>
        <input
          name="apiKey"
          type="password"
          required
          autoComplete="off"
          placeholder="…-us21"
          className="field font-mono text-[11px]"
        />
      </label>
      <label className="block">
        <span className="eyebrow block mb-1.5">
          Audience ID <span className="normal-case tracking-normal">(optional)</span>
        </span>
        <input
          name="listId"
          type="text"
          autoComplete="off"
          placeholder="6f7bc677e9"
          className="field font-mono text-[11px]"
        />
      </label>
      <p className="text-[11px] text-[var(--color-type-lo)] leading-snug">
        Mailchimp &rarr; <span className="mono">Account &rarr; Extras &rarr; API keys</span>. The
        key ends with its datacenter (<span className="mono">-us21</span>), which is also the API
        host &mdash; the Studio reads it from the key rather than asking. Verified before it is
        saved, then stored encrypted.
      </p>
      <p className="text-[11px] text-[var(--color-type-lo)] leading-snug">
        Leave the audience blank and the Studio lists what the key reaches. A wrong audience ID
        is a briefing sent to the wrong people, and Mailchimp will not say it was wrong.
      </p>
      <Submit className="btn btn-xs btn-primary">Verify &amp; connect</Submit>
      <Feedback state={state} />
    </form>
  );
}

export function ConnectPrintfulForm() {
  const [state, action] = useActionState(connectPrintfulAction, undefined);
  return (
    <form action={action} className="space-y-2">
      <label className="block">
        <span className="eyebrow block mb-1.5">API token</span>
        <input
          name="token"
          type="password"
          required
          autoComplete="off"
          className="field font-mono text-[11px]"
        />
      </label>
      <label className="block">
        <span className="eyebrow block mb-1.5">
          Shop web address{" "}
          <span className="normal-case tracking-normal">(recommended)</span>
        </span>
        <input
          name="website"
          type="text"
          autoComplete="off"
          placeholder="shop.jeffreyprather.com"
          className="field font-mono text-[11px]"
        />
      </label>
      <label className="block">
        <span className="eyebrow block mb-1.5">
          Store ID <span className="normal-case tracking-normal">(only if asked)</span>
        </span>
        <input
          name="storeId"
          type="text"
          autoComplete="off"
          className="field font-mono text-[11px]"
        />
      </label>
      <p className="text-[11px] text-[var(--color-type-lo)] leading-snug">
        Printful &rarr; <span className="mono">Settings &rarr; Developers &rarr; API tokens</span>.
        It needs read access to stores and products; nothing here ever writes to Printful.
        Verified before it is saved, then stored encrypted.
      </p>
      <p className="text-[11px] text-[var(--color-type-lo)] leading-snug">
        The shop address matters: Printful fulfils orders but does not host the shop, so it
        usually cannot tell us where a product is actually bought. Without an address the
        Studio has no link to put behind a merch item.
      </p>
      <Submit className="btn btn-xs btn-primary">Verify &amp; connect</Submit>
      <Feedback state={state} />
    </form>
  );
}

/** Read recent episodes. Read-only — nothing is created or modified. */
export function SyncBuzzsproutButton() {
  const [state, action] = useActionState(syncBuzzsproutAction, undefined);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <Submit className="btn btn-xs">Read recent episodes</Submit>
      <Feedback state={state} />
    </form>
  );
}
