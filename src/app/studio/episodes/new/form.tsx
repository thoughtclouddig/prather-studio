"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { createEpisodeAction } from "@/app/studio/phase2-actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Creating…" : "Create episode"}
    </button>
  );
}

export function NewEpisodeForm({
  defaultScheduledAt,
  showName,
  cadence,
  platformCount,
}: {
  defaultScheduledAt: string;
  showName: string;
  cadence: string | null;
  platformCount: number;
}) {
  const [state, action] = useActionState(createEpisodeAction, undefined);

  return (
    <form action={action} className="panel">
      <header className="panel-head">
        <div>
          <div className="eyebrow">{showName}</div>
          <div className="text-[13px] font-bold tracking-tight">New episode</div>
        </div>
        {cadence && <span className="mono">{cadence}</span>}
      </header>

      <div className="p-4 grid gap-4 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="eyebrow block mb-1.5">Working title</span>
          <input
            name="workingTitle"
            required
            autoFocus
            placeholder="What the show is about — the packaged headline comes later"
            className="field"
          />
        </label>

        <label>
          <span className="eyebrow block mb-1.5">Scheduled (show time, ET)</span>
          <input
            type="datetime-local"
            name="scheduledAt"
            defaultValue={defaultScheduledAt}
            className="field"
          />
        </label>

        <label>
          <span className="eyebrow block mb-1.5">Episode number (optional)</span>
          <input
            type="number"
            name="episodeNumber"
            inputMode="numeric"
            className="field"
            placeholder="523"
          />
        </label>

        <label className="sm:col-span-2">
          <span className="eyebrow block mb-1.5">Internal notes</span>
          <textarea
            name="internalNotes"
            rows={3}
            className="field"
            placeholder="Jeff's rundown, guests, anything the packaging step should know."
          />
        </label>

        <div className="sm:col-span-2 flex items-center gap-3 flex-wrap">
          <Submit />
          <span className="text-[11px] text-[var(--color-type-lo)]">
            {platformCount} platform rows are created automatically.
          </span>
          {state?.error && (
            <span className="text-[11px] text-[var(--color-signal-red)]">{state.error}</span>
          )}
        </div>
      </div>
    </form>
  );
}
