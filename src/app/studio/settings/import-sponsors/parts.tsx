"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { importSponsorsAction } from "../actions";
import type { SponsorCandidate } from "@/lib/domain/sponsor-import";

function Submit({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Adding…" : children}
    </button>
  );
}

/**
 * The review step.
 *
 * Every candidate is editable before it is saved. The parser is reading
 * marketing copy out of nested table markup, so it will sometimes get a name
 * slightly wrong — and a promo code transcribed wrong and mailed to the whole
 * list is the failure this screen exists to prevent.
 */
export function CandidateReview({
  candidates,
  existingNames,
}: {
  candidates: SponsorCandidate[];
  existingNames: string[];
}) {
  const [state, action] = useActionState(importSponsorsAction, undefined);
  const already = new Set(existingNames.map((n) => n.toLowerCase().trim()));

  return (
    <form action={action}>
      <div className="divide-y divide-[var(--color-ink-200)]">
        {candidates.map((c, i) => {
          const duplicate = already.has(c.name.toLowerCase().trim());
          return (
            <label
              key={`${c.name}-${i}`}
              className="flex items-start gap-3 p-3 cursor-pointer"
            >
              <input
                type="checkbox"
                name="sponsor"
                value={JSON.stringify({ name: c.name, url: c.url, offer: c.offer })}
                defaultChecked={c.confident && !duplicate}
                disabled={duplicate}
                className="mt-1 accent-[var(--color-brand)]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-[13px]">{c.name}</span>
                  {duplicate && (
                    <span className="eyebrow text-[var(--color-type-lo)]">
                      already in the list
                    </span>
                  )}
                  {!c.confident && !duplicate && (
                    <span className="eyebrow text-[var(--color-signal-amber)]">
                      unsure
                    </span>
                  )}
                </span>
                <span className="block text-[12px] text-[var(--color-type-lo)] mt-0.5">
                  {c.offer ?? "no offer line found"}
                  {c.url ? ` · ${c.url}` : " · no link found"}
                </span>
                <span className="block text-[11px] text-[var(--color-type-lo)] mt-0.5 italic">
                  {c.reason}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      <div className="p-4 border-t border-[var(--color-ink-200)]">
        <Submit>Add the ticked sponsors</Submit>
        <p className="text-[11px] text-[var(--color-type-lo)] mt-2 leading-snug">
          Names, codes and links can all be corrected afterwards in Settings.
        </p>
        {state?.error && (
          <p className="text-[12px] text-[var(--color-signal-red)] mt-2">{state.error}</p>
        )}
        {state?.ok && (
          <p className="text-[12px] text-[var(--color-signal-green)] mt-2">{state.ok}</p>
        )}
      </div>
    </form>
  );
}
