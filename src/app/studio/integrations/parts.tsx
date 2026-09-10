"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  connectRumbleAction,
  disconnectIntegrationAction,
  pollRumbleNowAction,
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
        <span className="eyebrow block mb-1.5">Live Stream API URL</span>
        <input
          name="apiUrl"
          type="password"
          required
          autoComplete="off"
          placeholder="https://rumble.com/-livestream-api/get-data?key=…"
          className="field font-mono text-[11px]"
        />
      </label>
      <p className="text-[11px] text-[var(--color-type-lo)] leading-snug">
        Generate it at <span className="mono">rumble.com/account/livestream-api</span>. The URL
        contains your key, so it is stored encrypted and never displayed again.
      </p>
      <Submit className="btn btn-xs btn-primary">Test &amp; connect</Submit>
      <Feedback state={state} />
    </form>
  );
}
