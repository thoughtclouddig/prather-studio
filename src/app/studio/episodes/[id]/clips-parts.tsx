"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { requestClipsAction } from "@/app/studio/phase2-actions";

export interface ClipRow {
  id: string;
  title: string;
  description: string | null;
  hashtags: string | null;
  durationSeconds: number | null;
  previewUrl: string | null;
  downloadUrl: string | null;
}

function Submit({ children, disabled }: { children: React.ReactNode; disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-xs btn-primary" disabled={pending || disabled}>
      {pending ? "Sending…" : children}
    </button>
  );
}

export function ClipRunner({
  episodeId,
  clips,
  canRun,
  hasVideo,
  running,
}: {
  episodeId: string;
  clips: ClipRow[];
  canRun: boolean;
  hasVideo: boolean;
  running: boolean;
}) {
  const [state, action] = useActionState(requestClipsAction, undefined);

  return (
    <div className="px-4 py-3.5 space-y-3">
      <p className="text-[12px] text-[var(--color-type-lo)] leading-relaxed max-w-[76ch]">
        Sends the recording to OpusClip and keeps what comes back. It asks for 30&ndash;90
        second clips &mdash; long enough to carry a point, short enough that the platforms
        reward them. Their storage expires, so download anything worth keeping.
      </p>

      {canRun && (
        <form action={action} className="inline-flex flex-col items-start">
          <input type="hidden" name="episodeId" value={episodeId} />
          <Submit disabled={!hasVideo}>
            {clips.length > 0 ? "Run again" : running ? "Run again" : "Send for clipping"}
          </Submit>
          {!hasVideo && (
            <p className="text-[11px] text-[var(--color-type-lo)] mt-1.5 leading-snug">
              Link the YouTube video first &mdash; OpusClip needs somewhere to download
              from, and a Rumble embed URL is a player rather than a file.
            </p>
          )}
          {state?.error && (
            <p className="text-[11px] text-[var(--color-signal-red)] mt-1.5 leading-snug">
              {state.error}
            </p>
          )}
          {state?.ok && (
            <p className="text-[11px] text-[var(--color-signal-green)] mt-1.5 leading-snug">
              {state.ok}
            </p>
          )}
        </form>
      )}

      {clips.length > 0 && (
        <div className="divide-y divide-[var(--color-ink-200)] border-t border-[var(--color-ink-200)] mt-1">
          {clips.map((clip) => (
            <div key={clip.id} className="py-2.5 flex items-start gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">{clip.title}</div>
                {clip.description && (
                  <p className="text-[12px] text-[var(--color-type-lo)] mt-0.5 leading-snug">
                    {clip.description}
                  </p>
                )}
                <div className="mono text-[11px] text-[var(--color-type-lo)] mt-1">
                  {clip.durationSeconds ? `${clip.durationSeconds}s` : "—"}
                  {clip.hashtags ? ` · ${clip.hashtags}` : ""}
                </div>
              </div>
              <div className="inline-flex gap-2">
                {clip.previewUrl && (
                  <a
                    href={clip.previewUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="btn btn-xs btn-ghost"
                  >
                    Preview
                  </a>
                )}
                {clip.downloadUrl && (
                  <a
                    href={clip.downloadUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="btn btn-xs"
                  >
                    Download
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
