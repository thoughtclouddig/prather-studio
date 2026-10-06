"use client";

import { useState } from "react";

/**
 * The Rumble handoff.
 *
 * Rumble exposes no metadata write for an existing video. Its Live Stream API
 * is read-only, and `simple-upload.php` CREATES a video rather than updating
 * one — calling it on a show that already exists as a livestream would produce
 * a second copy, which is the duplicate problem Phase 3 §1 spent a day
 * untangling on YouTube.
 *
 * So the description, chapters and thumbnail stay manual. The Studio does
 * everything up to the paste: it composes exactly what YouTube gets, from the
 * same approved drafts, and hands it over in one click. The step is tracked as
 * outstanding rather than quietly skipped — a manual step the system knows
 * about is a pipeline step; one it pretends does not exist is a gap.
 */
export function RumbleHandoff({
  description,
  chapters,
  videoUrl,
}: {
  description: string | null;
  chapters: string | null;
  videoUrl: string | null;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [showing, setShowing] = useState(false);

  const composed = [description?.trim(), chapters?.trim() ? `CHAPTERS\n${chapters.trim()}` : null]
    .filter(Boolean)
    .join("\n\n");

  async function copy(what: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2500);
    } catch {
      setShowing(true);
    }
  }

  if (!composed) {
    return (
      <div className="px-4 py-3.5">
        <div className="rail-val state-muted mb-1.5">
          <span>Nothing approved yet</span>
        </div>
        <p className="text-[12px] text-[var(--color-type-lo)] leading-relaxed max-w-[64ch]">
          Approve a description in Review and it will be composed here, ready to paste into
          Rumble.
        </p>
      </div>
    );
  }

  return (
    <div className="px-4 py-3.5 space-y-3">
      <div className="flex items-center gap-2.5 flex-wrap">
        <button
          type="button"
          onClick={() => copy("all", composed)}
          className="btn btn-xs btn-primary"
        >
          {copied === "all" ? "Copied" : "Copy description + chapters"}
        </button>
        {chapters && (
          <button
            type="button"
            onClick={() => copy("chapters", chapters)}
            className="btn btn-xs"
          >
            {copied === "chapters" ? "Copied" : "Chapters only"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowing((v) => !v)}
          className="btn btn-xs btn-ghost"
        >
          {showing ? "Hide" : "Show"}
        </button>
        {videoUrl && (
          <a href={videoUrl} target="_blank" rel="noreferrer" className="link text-[12px] font-semibold">
            Open on Rumble &rarr;
          </a>
        )}
      </div>

      {showing && (
        <textarea
          readOnly
          value={composed}
          onFocus={(e) => e.currentTarget.select()}
          className="field font-mono text-[11px] h-[220px] leading-relaxed"
        />
      )}

      <p className="text-[12px] text-[var(--color-type-lo)] leading-relaxed max-w-[72ch]">
        This is the same copy YouTube gets, from the same approved drafts.{" "}
        <strong className="text-[var(--color-type-mid)]">Rumble has no write API for an
        existing video</strong> &mdash; its upload endpoint creates a new one, which would make
        a second copy of the show &mdash; so this is a paste, and the Studio tracks it as
        outstanding rather than pretending it happened.
      </p>
      <p className="text-[11px] text-[var(--color-type-lo)] leading-relaxed max-w-[72ch]">
        Whether Rumble renders timestamp chapters the way YouTube does is untested. Worth
        checking once on a real episode before relying on it.
      </p>
    </div>
  );
}
