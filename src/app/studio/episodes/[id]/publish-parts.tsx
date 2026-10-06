"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  createBuzzsproutDraftAction,
  createWordPressDraftAction,
} from "@/app/studio/phase2-actions";

function Submit({ children, className }: { children: React.ReactNode; className: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "Working…" : children}
    </button>
  );
}

function Result({ state }: { state?: { ok?: string; error?: string } }) {
  if (!state?.ok && !state?.error) return null;
  return (
    <p
      className={`text-[12px] leading-snug ${
        state.error
          ? "text-[var(--color-signal-red)]"
          : "text-[var(--color-signal-green)]"
      }`}
    >
      {state.error ?? state.ok}
    </p>
  );
}

/**
 * Create the Buzzsprout episode before the audio exists.
 *
 * Buzzsprout documents creating an episode with just a title and
 * `private: true`. Requiring audio first inverted the order the work happens
 * in — show notes are written and approved well before a recording is
 * exported — and left the podcast as the last thing done on a show day instead
 * of something already waiting.
 */
export function CreateBuzzsproutDraft({
  episodeId,
  hasHeadline,
  hasSquare,
}: {
  episodeId: string;
  hasHeadline: boolean;
  hasSquare: boolean;
}) {
  const [state, action] = useActionState(createBuzzsproutDraftAction, undefined);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="episodeId" value={episodeId} />
      <Submit className="btn btn-xs btn-primary">Create draft on Buzzsprout</Submit>
      <p className="text-[11px] text-[var(--color-type-lo)] leading-relaxed max-w-[64ch]">
        Creates a <strong>private</strong> episode carrying the approved title, show notes
        {hasSquare ? " and the square artwork" : ""} &mdash; no audio needed. Private is
        Buzzsprout&rsquo;s draft state, and since Buzzsprout has no delete, it is the only
        kind of mistake that can be walked back.
        {!hasSquare && " Upload the 1:1 thumbnail first to include artwork."}
      </p>
      {!hasHeadline && (
        <p className="text-[11px] text-[var(--color-signal-amber)]">
          Approve a headline first — it becomes the episode title.
        </p>
      )}
      <Result state={state} />
    </form>
  );
}

/**
 * Create the post on jeffreyprather.com.
 *
 * The Rumble URL is typed in because Rumble exposes no VOD listing — there is
 * no way to discover it. It is resolved through oEmbed rather than turned into
 * an iframe by hand: the page slug and the embed id are different strings, so
 * building the player from the page URL produces an embed that plays nothing.
 */
export function CreateWordPressDraft({
  episodeId,
  hasHeadline,
  hasSquare,
}: {
  episodeId: string;
  hasHeadline: boolean;
  hasSquare: boolean;
}) {
  const [state, action] = useActionState(createWordPressDraftAction, undefined);
  return (
    <form action={action} className="space-y-2.5">
      <input type="hidden" name="episodeId" value={episodeId} />
      <label className="block">
        <span className="eyebrow block mb-1.5">Rumble video URL</span>
        <input
          name="rumbleUrl"
          type="url"
          autoComplete="off"
          placeholder="https://rumble.com/v7g8rbk-....html"
          className="field font-mono text-[11px]"
        />
      </label>
      <Submit className="btn btn-xs btn-primary">Create WordPress draft</Submit>
      <p className="text-[11px] text-[var(--color-type-lo)] leading-relaxed max-w-[70ch]">
        Builds the post from the Rumble player, the approved summary and chapters, with the{" "}
        {hasSquare ? (
          <strong className="text-[var(--color-type-mid)]">1:1 as the featured image</strong>
        ) : (
          "1:1 as the featured image once uploaded"
        )}
        . It is created as a <strong>draft</strong> &mdash; the Studio cannot publish to the
        public site at all. Leave the URL blank to build the post without an embed.
      </p>
      {!hasHeadline && (
        <p className="text-[11px] text-[var(--color-signal-amber)]">
          Approve a headline first — it becomes the post title.
        </p>
      )}
      <Result state={state} />
    </form>
  );
}
