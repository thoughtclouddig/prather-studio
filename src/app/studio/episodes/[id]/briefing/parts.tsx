"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { scheduleBriefingAction } from "@/app/studio/phase2-actions";

/**
 * The confirm step for the only irreversible action in the Studio.
 *
 * It asks, and the question names the time and the audience size, because the
 * mistake this guards against is not mis-clicking — it is clicking correctly
 * while believing the send time is something else.
 */
export function ScheduleBriefingForm({
  episodeId,
  sendSummary,
  audienceLabel,
  disabled,
}: {
  episodeId: string;
  sendSummary: string;
  audienceLabel: string;
  disabled: boolean;
}) {
  const [state, action] = useActionState(scheduleBriefingAction, undefined);
  const { pending } = useFormStatus();

  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (
          !window.confirm(
            `Schedule this briefing to go out at ${sendSummary}?\n\n` +
              `It goes to ${audienceLabel}. Mailchimp has no undo once it sends — ` +
              `but it stays a draft until that time, and you can still change or ` +
              `cancel it in Mailchimp before then.`,
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="episodeId" value={episodeId} />
      <button
        type="submit"
        className="btn btn-primary"
        disabled={pending || disabled}
        title={disabled ? "Resolve what is missing first" : undefined}
      >
        {pending ? "Scheduling…" : `Schedule for ${sendSummary}`}
      </button>
      {state?.error && (
        <p className="text-[12px] text-[var(--color-signal-red)] mt-2 leading-snug whitespace-pre-wrap">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p className="text-[12px] text-[var(--color-signal-green)] mt-2 leading-snug">
          {state.ok}
        </p>
      )}
    </form>
  );
}
