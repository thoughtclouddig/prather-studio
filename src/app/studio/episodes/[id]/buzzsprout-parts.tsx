"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Hand the show audio to Buzzsprout.
 *
 * Posts to a route handler rather than a server action: server actions carry a
 * 1 MB body limit and buffer the payload, and the StreamYard audio-only export
 * is around 60 MB. Nothing is stored on our side — the file goes straight
 * through, because Phase 0 established the Replit filesystem does not survive a
 * republish and the safest media store is the one that does not exist.
 *
 * The 60 MB detail matters to the operator too, which is why it is in the help
 * text: exporting the full video instead is the easy mistake and produces a
 * 2 GB upload that would fail slowly.
 */
export function BuzzsproutAudioUpload({
  episodeId,
  hasAudio,
  blockedReason,
}: {
  episodeId: string;
  hasAudio: boolean;
  blockedReason: string | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<{ ok?: string; error?: string } | null>(null);

  async function send(file: File) {
    setBusy(true);
    setMessage(null);
    setProgress(0);

    const body = new FormData();
    body.append("audio", file);

    // XHR rather than fetch: a 60 MB upload needs a progress bar, and fetch
    // still cannot report upload progress.
    await new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/episodes/${episodeId}/buzzsprout/audio`);
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener("load", () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            setMessage({
              ok: data.created
                ? `Created Buzzsprout episode ${data.buzzsproutId} as PRIVATE. Publish it from Buzzsprout when you are happy with it.`
                : `Audio replaced on Buzzsprout episode ${data.buzzsproutId}.`,
            });
            router.refresh();
          } else {
            setMessage({ error: data.error ?? `Upload failed (${xhr.status}).` });
          }
        } catch {
          setMessage({ error: `Upload failed (${xhr.status}).` });
        }
        resolve();
      });
      xhr.addEventListener("error", () => {
        setMessage({ error: "The upload did not reach the server." });
        resolve();
      });
      xhr.send(body);
    });

    setBusy(false);
    setProgress(null);
    if (input.current) input.current.value = "";
  }

  if (blockedReason) {
    return (
      <div className="px-4 py-3.5">
        <div className="rail-val state-waiting mb-1.5">
          <span>Audio required</span>
        </div>
        <p className="text-[12px] text-[var(--color-type-lo)] leading-relaxed max-w-[62ch]">
          {blockedReason}
        </p>
      </div>
    );
  }

  return (
    <div className="px-4 py-3.5 space-y-2.5">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="btn btn-xs cursor-pointer">
          {hasAudio ? "Replace audio" : "Upload audio"}
          <input
            ref={input}
            type="file"
            accept="audio/*,.mp3,.m4a,.wav"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void send(file);
            }}
          />
        </label>
        {busy && progress !== null && (
          <span className="mono text-[12px]" role="status" aria-live="polite">
            {progress}%
          </span>
        )}
      </div>

      {busy && progress !== null && (
        <div className="h-1 bg-[var(--color-ink-200)]" aria-hidden="true">
          <div
            className="h-full bg-[var(--color-signal-blue)] transition-[width] duration-150"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      <p className="text-[12px] text-[var(--color-type-lo)] leading-relaxed max-w-[62ch]">
        Use StreamYard&rsquo;s <strong className="text-[var(--color-type-mid)]">audio-only</strong>{" "}
        export &mdash; about 60&nbsp;MB. The full video works but is 2&nbsp;GB and gains
        nothing for a podcast. The Studio keeps no copy; the file goes straight to
        Buzzsprout.
      </p>

      {message?.ok && (
        <p className="text-[12px] text-[var(--color-signal-green)] leading-relaxed">
          {message.ok}
        </p>
      )}
      {message?.error && (
        <p className="text-[12px] text-[var(--color-signal-red)] leading-relaxed">
          {message.error}
        </p>
      )}
    </div>
  );
}
