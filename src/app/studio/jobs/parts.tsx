"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { enqueueTestJobAction, retryJobAction } from "@/app/studio/actions";

function Submit({ children, className = "btn btn-xs" }: { children: React.ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "…" : children}
    </button>
  );
}

export function RetryButton({ jobId }: { jobId: string }) {
  const [state, action] = useActionState(retryJobAction, undefined);
  return (
    <form action={action} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="jobId" value={jobId} />
      <Submit className="btn btn-xs btn-primary">Retry</Submit>
      {state?.error && (
        <span className="text-[10px] text-[var(--color-signal-red)]">{state.error}</span>
      )}
    </form>
  );
}

/** Diagnostics. These two handlers exist so the whole job lifecycle can be
 *  watched live; neither contacts anything outside this database. */
export function TestJobControls() {
  const [state, action] = useActionState(enqueueTestJobAction, undefined);
  return (
    <form action={action} className="flex items-center gap-2 flex-wrap">
      <button type="submit" name="kind" value="ping" className="btn btn-xs">
        Run ping
      </button>
      <button type="submit" name="kind" value="fail-test" className="btn btn-xs btn-reject">
        Run fail-test
      </button>
      {state?.ok && (
        <span className="text-[11px] text-[var(--color-signal-green)]">{state.ok}</span>
      )}
      {state?.error && (
        <span className="text-[11px] text-[var(--color-signal-red)]">{state.error}</span>
      )}
    </form>
  );
}
