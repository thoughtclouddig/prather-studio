"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The thumbnail step.
 *
 * The brief is generated here and copied out; the images come back by upload.
 * That split is deliberate and evidence-based — the operator's ChatGPT thread
 * carries months of previous thumbnails and produces excellent results every
 * week, while the same brief sent to the image API produced poor ones. The
 * Studio does not try to out-generate a process that works. It removes the
 * steps around it.
 */
export function ThumbnailStep({
  episodeId,
  brief,
  hasHeadline,
  existing,
}: {
  episodeId: string;
  brief: string;
  hasHeadline: boolean;
  existing: { kind: string; id: string; width: number | null; height: number | null }[];
}) {
  const [copied, setCopied] = useState(false);
  const [showBrief, setShowBrief] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(brief);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setShowBrief(true);
    }
  }

  if (!hasHeadline) {
    return (
      <div className="px-4 py-3.5">
        <div className="rail-val state-waiting mb-1.5">
          <span>Headline required</span>
        </div>
        <p className="text-[12px] text-[var(--color-type-lo)] leading-relaxed max-w-[64ch]">
          The brief carries the approved headline into the artwork, so approve a primary
          headline in Review first. Generating before then would put a working title on
          the thumbnail.
        </p>
      </div>
    );
  }

  const find = (kind: string) => existing.find((i) => i.kind === kind);
  const master = find("THUMBNAIL_16_9");
  const square = find("THUMBNAIL_1_1");

  return (
    <div className="px-4 py-3.5 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" onClick={copy} className="btn btn-xs btn-primary">
          {copied ? "Copied" : "Copy the brief"}
        </button>
        <button
          type="button"
          onClick={() => setShowBrief((v) => !v)}
          className="btn btn-xs btn-ghost"
        >
          {showBrief ? "Hide" : "Show"} brief
        </button>
        <span className="mono text-[11px]">paste into your thumbnail thread</span>
      </div>

      {showBrief && (
        <textarea
          readOnly
          value={brief}
          onFocus={(e) => e.currentTarget.select()}
          className="field font-mono text-[11px] h-[260px] leading-relaxed"
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Slot
          episodeId={episodeId}
          kind="THUMBNAIL_16_9"
          label="Master — 1920 × 1080"
          usedFor="YouTube thumbnail"
          image={master}
        />
        <Slot
          episodeId={episodeId}
          kind="THUMBNAIL_1_1"
          label="Square — 1024 × 1024"
          usedFor="Podcast artwork · WordPress featured image"
          image={square}
        />
      </div>
    </div>
  );
}

function Slot({
  episodeId,
  kind,
  label,
  usedFor,
  image,
}: {
  episodeId: string;
  kind: string;
  label: string;
  usedFor: string;
  image?: { id: string; width: number | null; height: number | null };
}) {
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(file: File) {
    setBusy(true);
    setError(null);
    const body = new FormData();
    body.append("kind", kind);
    body.append("image", file);
    try {
      const res = await fetch(`/api/episodes/${episodeId}/thumbnail`, {
        method: "POST",
        body,
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? `Upload failed (${res.status}).`);
      else router.refresh();
    } catch {
      setError("The upload did not reach the server.");
    }
    setBusy(false);
    if (input.current) input.current.value = "";
  }

  return (
    <div className="sunk p-3 space-y-2.5 min-w-0">
      <div>
        <div className="rail-key">{label}</div>
        <div className="text-[11px] text-[var(--color-type-lo)] mt-0.5">{usedFor}</div>
      </div>

      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/images/${image.id}`}
          alt={label}
          className="w-full border border-[var(--color-ink-300)]"
        />
      ) : (
        <div className="aspect-video flex items-center justify-center border border-dashed border-[var(--color-ink-300)] text-[11px] text-[var(--color-type-lo)]">
          nothing uploaded yet
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <label className="btn btn-xs cursor-pointer">
          {busy ? "Uploading…" : image ? "Replace" : "Upload"}
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void send(file);
            }}
          />
        </label>
        {image?.width ? (
          <span className="mono text-[11px]">
            {image.width}×{image.height}
          </span>
        ) : null}
      </div>

      {error && (
        <p className="text-[12px] text-[var(--color-signal-red)] leading-snug">{error}</p>
      )}
    </div>
  );
}
