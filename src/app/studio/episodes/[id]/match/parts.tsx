"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { linkYouTubeAction } from "@/app/studio/phase2-actions";

function Submit({ children, className = "btn btn-xs" }: { children: React.ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "…" : children}
    </button>
  );
}

function Feedback({ state }: { state: { ok?: string; error?: string } | undefined }) {
  if (state?.error)
    return <p className="text-[11px] text-[var(--color-signal-red)] mt-1.5">{state.error}</p>;
  if (state?.ok)
    return <p className="text-[11px] text-[var(--color-signal-green)] mt-1.5">{state.ok}</p>;
  return null;
}

/** One confirmation per candidate. Nothing attaches without this click. */
export function ConfirmMatchButton({
  episodeId,
  videoId,
  strong,
}: {
  episodeId: string;
  videoId: string;
  strong: boolean;
}) {
  const [state, action] = useActionState(linkYouTubeAction, undefined);
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="episodeId" value={episodeId} />
      <input type="hidden" name="videoId" value={videoId} />
      <input type="hidden" name="via" value="candidate" />
      <Submit className={`btn btn-xs ${strong ? "btn-primary" : ""}`}>Match</Submit>
      <Feedback state={state} />
    </form>
  );
}

export function ManualLinkForm({ episodeId }: { episodeId: string }) {
  const [state, action] = useActionState(linkYouTubeAction, undefined);
  return (
    <form action={action} className="p-4 space-y-2">
      <input type="hidden" name="episodeId" value={episodeId} />
      <input type="hidden" name="via" value="manual" />
      <label className="block">
        <span className="eyebrow block mb-1.5">Video ID or URL</span>
        <input
          name="videoId"
          required
          placeholder="dQw4w9WgXcQ  or  https://www.youtube.com/watch?v=…"
          className="field mono"
        />
      </label>
      <Submit>Link this video</Submit>
      <Feedback state={state} />
    </form>
  );
}
