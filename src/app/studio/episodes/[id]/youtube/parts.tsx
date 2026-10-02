"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { applyYouTubeUpdateAction } from "@/app/studio/phase2-actions";

function Submit({ label, disabled }: { label: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending || disabled}>
      {pending ? "Sending to YouTube…" : label}
    </button>
  );
}

/**
 * The confirmation.
 *
 * It carries the fingerprint of the exact remote state the operator was shown.
 * If the video moved between render and submit, the server refuses rather than
 * overwriting whatever is there now.
 */
export function ConfirmUpdateForm({
  episodeId,
  fingerprint,
  driftFields,
  changedFields,
}: {
  episodeId: string;
  fingerprint: string;
  driftFields: string[];
  changedFields: string[];
}) {
  const [state, action] = useActionState(applyYouTubeUpdateAction, undefined);
  const [acknowledged, setAcknowledged] = useState(false);
  const needsAck = driftFields.length > 0;

  return (
    <form action={action} className="p-4 space-y-3">
      <input type="hidden" name="episodeId" value={episodeId} />
      <input type="hidden" name="fingerprint" value={fingerprint} />

      {needsAck && (
        <label className="flex items-start gap-2.5 p-3 border border-[#6d5a1f] bg-[#1d1809]">
          <input
            type="checkbox"
            name="acknowledgeDrift"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-[12px] leading-snug">
            <strong className="text-[var(--color-signal-amber)]">
              The {driftFields.join(" and ")} changed on YouTube since the Studio last synced.
            </strong>{" "}
            Someone edited this video outside the Studio. Tick to confirm you have read the
            current remote value above and intend to replace it.
          </span>
        </label>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <Submit
          label={`Update YouTube — ${changedFields.join(" and ")}`}
          disabled={needsAck && !acknowledged}
        />
        <span className="text-[11px] text-[var(--color-type-lo)]">
          Updates the existing video. Never uploads a copy.
        </span>
      </div>

      {state?.error && (
        <p className="text-[12px] text-[var(--color-signal-red)] leading-snug">{state.error}</p>
      )}
      {state?.ok && (
        <p className="text-[12px] text-[var(--color-signal-green)] leading-snug">{state.ok}</p>
      )}
    </form>
  );
}
