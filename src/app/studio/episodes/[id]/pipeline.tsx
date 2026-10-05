"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  enqueueCaptionsAction,
  enqueuePackageAction,
  regenerateContentAction,
  unlinkYouTubeAction,
} from "@/app/studio/phase2-actions";

function Submit({
  children,
  className = "btn btn-xs",
  disabled,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending || disabled} title={title}>
      {pending ? "…" : children}
    </button>
  );
}

function Feedback({ state }: { state: { ok?: string; error?: string } | undefined }) {
  if (state?.error)
    return (
      <p className="text-[11px] text-[var(--color-signal-red)] mt-1.5 leading-snug">
        {state.error}
      </p>
    );
  if (state?.ok)
    return (
      <p className="text-[11px] text-[var(--color-signal-green)] mt-1.5 leading-snug">
        {state.ok}
      </p>
    );
  return null;
}

export function FetchCaptionsButton({
  episodeId,
  disabled,
  hasTranscript,
}: {
  episodeId: string;
  disabled: boolean;
  hasTranscript: boolean;
}) {
  const [state, action] = useActionState(enqueueCaptionsAction, undefined);
  return (
    <form action={action} className="inline-flex flex-col items-start">
      <input type="hidden" name="episodeId" value={episodeId} />
      <Submit
        disabled={disabled}
        title={disabled ? "Link a YouTube video first" : undefined}
      >
        {hasTranscript ? "Re-fetch captions" : "Retrieve transcript"}
      </Submit>
      <Feedback state={state} />
    </form>
  );
}

export function RunPackageButton({
  episodeId,
  disabled,
  hasDrafts,
}: {
  episodeId: string;
  disabled: boolean;
  hasDrafts: boolean;
}) {
  const [state, action] = useActionState(enqueuePackageAction, undefined);
  return (
    <form action={action} className="inline-flex flex-col items-start">
      <input type="hidden" name="episodeId" value={episodeId} />
      <Submit
        className={`btn btn-xs ${hasDrafts ? "" : "btn-primary"}`}
        disabled={disabled}
        title={disabled ? "A transcript is required first" : undefined}
      >
        {hasDrafts ? "Re-run content engine" : "Run content engine"}
      </Submit>
      <Feedback state={state} />
    </form>
  );
}

/**
 * Discard every draft and start the package over.
 *
 * Separate from "Re-run content engine", which only retires PROPOSED drafts —
 * an APPROVED draft is a human decision and is never discarded by a machine.
 * That left no way out of the state two packaging runs created, where
 * approvals ended up spread across two sets of everything. This is the
 * explicit, operator-initiated exit, and it asks first because it throws away
 * approvals.
 */
export function RegenerateContentButton({
  episodeId,
  disabled,
}: {
  episodeId: string;
  disabled: boolean;
}) {
  const [state, action] = useActionState(regenerateContentAction, undefined);
  return (
    <form
      action={action}
      className="inline-flex flex-col items-start"
      onSubmit={(event) => {
        if (
          !window.confirm(
            "Discard EVERY draft for this episode, including approved ones, and " +
              "generate a fresh package?\n\nNothing is deleted — the old drafts stay " +
              "as history — but your approvals will have to be made again.",
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="episodeId" value={episodeId} />
      <Submit className="btn btn-xs btn-reject" disabled={disabled}>
        Clear &amp; regenerate
      </Submit>
      <Feedback state={state} />
    </form>
  );
}

export function UnlinkYouTubeButton({ episodeId }: { episodeId: string }) {
  const [state, action] = useActionState(unlinkYouTubeAction, undefined);
  return (
    <form action={action} className="inline-flex flex-col items-start">
      <input type="hidden" name="episodeId" value={episodeId} />
      <Submit className="btn btn-xs btn-ghost">Unlink</Submit>
      <Feedback state={state} />
    </form>
  );
}
