"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { deleteEpisodeAction } from "@/app/studio/actions";

function Submit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-xs btn-reject" disabled={pending || disabled}>
      {pending ? "Deleting…" : "Delete this episode"}
    </button>
  );
}

/**
 * Deleting an episode.
 *
 * Behind a disclosure, because it is for mistakes — a duplicate, a test, one
 * created on the wrong date — and a real broadcast should be corrected rather
 * than removed. Owning the archive is the point of this system.
 *
 * The title must be typed to enable it. A confirm dialog is muscle memory by
 * the fourth time; typing the name of the thing is not, and this is the only
 * control here that destroys a transcript.
 */
export function DeleteEpisode({
  episodeId,
  title,
  impact,
}: {
  episodeId: string;
  title: string;
  impact: {
    drafts: number;
    transcripts: number;
    publications: number;
    images: number;
    jobs: number;
    liveOn: string[];
  };
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [state, action] = useActionState(deleteEpisodeAction, undefined);

  const matches = typed.trim() === title.trim();

  const goes = [
    impact.drafts > 0 && `${impact.drafts} draft${impact.drafts === 1 ? "" : "s"}`,
    impact.transcripts > 0 &&
      `${impact.transcripts} transcript${impact.transcripts === 1 ? "" : "s"}`,
    impact.publications > 0 &&
      `${impact.publications} publication link${impact.publications === 1 ? "" : "s"}`,
    impact.images > 0 && `${impact.images} image${impact.images === 1 ? "" : "s"}`,
    impact.jobs > 0 && `${impact.jobs} job record${impact.jobs === 1 ? "" : "s"}`,
  ].filter(Boolean) as string[];

  if (!open) {
    return (
      <div className="px-4 py-3">
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          onClick={() => setOpen(true)}
        >
          Delete this episode
        </button>
      </div>
    );
  }

  return (
    <div className="px-4 py-3.5 space-y-3">
      <p className="text-[12px] leading-relaxed max-w-[70ch]">
        This removes the episode and everything attached to it
        {goes.length > 0 ? (
          <>
            {" "}&mdash;{" "}
            <strong className="text-[var(--color-type-hi)]">{goes.join(", ")}</strong>
          </>
        ) : null}
        . It cannot be undone.
      </p>

      {impact.liveOn.length > 0 && (
        <p className="text-[12px] text-[var(--color-signal-amber)] leading-relaxed max-w-[70ch]">
          This episode is published or scheduled on{" "}
          <strong>{impact.liveOn.join(", ")}</strong>. Deleting it here does not remove it
          there &mdash; it only loses the link between them, and nothing in the Studio will
          be able to match that video again.
        </p>
      )}

      <form action={action} className="space-y-2">
        <input type="hidden" name="episodeId" value={episodeId} />
        {impact.liveOn.length > 0 && (
          <label className="flex items-center gap-2 text-[12px]">
            <input type="checkbox" name="force" className="accent-[var(--color-brand)]" />
            Delete anyway, losing the link
          </label>
        )}
        <label className="block max-w-[46ch]">
          <span className="eyebrow block mb-1.5">
            Type the title to confirm
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="field"
            placeholder={title}
            autoComplete="off"
          />
        </label>
        <div className="flex items-center gap-2">
          <Submit disabled={!matches} />
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            onClick={() => {
              setOpen(false);
              setTyped("");
            }}
          >
            Cancel
          </button>
        </div>
        {state?.error && (
          <p className="text-[12px] text-[var(--color-signal-red)] leading-snug">
            {state.error}
          </p>
        )}
      </form>
    </div>
  );
}
