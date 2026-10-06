"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  createSponsorAction,
  deleteSponsorAction,
  reorderSponsorAction,
  updateSponsorAction,
  type ActionState,
} from "./actions";

export interface SponsorRow {
  id: string;
  name: string;
  url: string | null;
  offer: string | null;
  active: boolean;
}

function Submit({
  children,
  className = "btn btn-xs",
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} title={title}>
      {pending ? "…" : children}
    </button>
  );
}

function Feedback({ state }: { state: ActionState }) {
  if (state?.error)
    return (
      <p className="text-[11px] text-[var(--color-signal-red)] mt-1.5 leading-snug">
        {state.error}
      </p>
    );
  if (state?.ok)
    return (
      <p className="text-[11px] text-[var(--color-signal-green)] mt-1.5 leading-snug">
        {state.ok}
      </p>
    );
  return null;
}

/**
 * One sponsor, editable in place.
 *
 * Editing happens in the row rather than behind a modal because the thing most
 * likely to change is a promo code — a four-character edit that should not
 * need a dialog, a save, and a page back.
 */
function SponsorEditor({ sponsor, position, count }: {
  sponsor: SponsorRow;
  position: number;
  count: number;
}) {
  const [open, setOpen] = useState(false);
  const [saveState, save] = useActionState(updateSponsorAction, undefined);
  const [removeState, remove] = useActionState(deleteSponsorAction, undefined);
  const [moveState, move] = useActionState(reorderSponsorAction, undefined);

  return (
    <div className="p-3 border-b border-[var(--color-ink-200)] last:border-b-0">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-[13px]">{sponsor.name}</span>
            {!sponsor.active && (
              <span className="eyebrow text-[var(--color-type-lo)]">paused</span>
            )}
          </div>
          <p className="text-[12px] text-[var(--color-type-lo)] mt-0.5">
            {sponsor.offer ?? "no offer line"}
            {sponsor.url ? ` · ${sponsor.url}` : " · no link"}
          </p>
        </div>

        <div className="inline-flex gap-1.5 items-start">
          <form action={move}>
            <input type="hidden" name="id" value={sponsor.id} />
            <input type="hidden" name="direction" value="up" />
            <Submit className="btn btn-xs btn-ghost" title="Move up">
              ↑
            </Submit>
          </form>
          <form action={move}>
            <input type="hidden" name="id" value={sponsor.id} />
            <input type="hidden" name="direction" value="down" />
            <Submit className="btn btn-xs btn-ghost" title="Move down">
              ↓
            </Submit>
          </form>
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? "Close" : "Edit"}
          </button>
        </div>
      </div>

      <Feedback state={moveState} />

      {open && (
        <div className="mt-3 pt-3 border-t border-[var(--color-ink-200)]">
          <form action={save} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="id" value={sponsor.id} />
            <label className="block">
              <span className="eyebrow">Name</span>
              <input name="name" defaultValue={sponsor.name} className="field mt-1" required />
            </label>
            <label className="block">
              <span className="eyebrow">Offer line</span>
              <input
                name="offer"
                defaultValue={sponsor.offer ?? ""}
                className="field mt-1"
                placeholder="code PRATHER for 15%"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="eyebrow">Link</span>
              <input
                name="url"
                defaultValue={sponsor.url ?? ""}
                className="field mt-1"
                placeholder="example.com"
              />
            </label>
            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                name="active"
                defaultChecked={sponsor.active}
                className="accent-[var(--color-brand)]"
              />
              Include in the briefing
            </label>
            <div className="sm:col-span-2 flex items-center gap-2">
              <Submit className="btn btn-xs btn-primary">Save</Submit>
              <span className="text-[11px] text-[var(--color-type-lo)]">
                Position {position} of {count}
              </span>
            </div>
          </form>
          <Feedback state={saveState} />

          <form
            action={remove}
            className="mt-3 pt-3 border-t border-[var(--color-ink-200)]"
            onSubmit={(event) => {
              if (
                !window.confirm(
                  `Remove ${sponsor.name} entirely?\n\nTo pause them instead and keep ` +
                    `the details, untick "Include in the briefing" and save.`,
                )
              ) {
                event.preventDefault();
              }
            }}
          >
            <input type="hidden" name="id" value={sponsor.id} />
            <Submit className="btn btn-xs btn-reject">Remove</Submit>
          </form>
          <Feedback state={removeState} />
        </div>
      )}
    </div>
  );
}

export function SponsorManager({
  sponsors,
  canEdit,
}: {
  sponsors: SponsorRow[];
  canEdit: boolean;
}) {
  const [addState, add] = useActionState(createSponsorAction, undefined);
  const [adding, setAdding] = useState(false);

  if (!canEdit) {
    return (
      <div className="p-4 text-[12px] text-[var(--color-type-lo)]">
        Sponsors are managed by the owner. A sponsor block carries a promo code
        someone is paid for, so it sits with the publishing defaults rather than with
        episode content.
      </div>
    );
  }

  return (
    <div>
      <p className="px-4 py-2.5 text-[12px] text-[var(--color-type-lo)] leading-relaxed border-b border-[var(--color-ink-200)]">
        These appear in every briefing, in this order. Untick{" "}
        <strong className="text-[var(--color-type-mid)]">Include in the briefing</strong>{" "}
        to pause one without losing the details.
      </p>

      {sponsors.length === 0 ? (
        <div className="p-4 text-[12px] text-[var(--color-type-lo)]">
          No sponsors yet. The briefing simply omits the section until there is one.
        </div>
      ) : (
        <div>
          {sponsors.map((s, i) => (
            <SponsorEditor
              key={s.id}
              sponsor={s}
              position={i + 1}
              count={sponsors.length}
            />
          ))}
        </div>
      )}

      <div className="p-3 border-t border-[var(--color-ink-200)]">
        {adding ? (
          <form action={add} className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="eyebrow">Name</span>
              <input name="name" className="field mt-1" required autoFocus />
            </label>
            <label className="block">
              <span className="eyebrow">Offer line</span>
              <input name="offer" className="field mt-1" placeholder="code PRATHER for 15%" />
            </label>
            <label className="block sm:col-span-2">
              <span className="eyebrow">Link</span>
              <input name="url" className="field mt-1" placeholder="example.com" />
            </label>
            <div className="sm:col-span-2 flex items-center gap-2">
              <Submit className="btn btn-xs btn-primary">Add sponsor</Submit>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="inline-flex gap-2 flex-wrap">
            <button type="button" className="btn btn-xs" onClick={() => setAdding(true)}>
              Add a sponsor
            </button>
            <a href="/studio/settings/import-sponsors" className="btn btn-xs btn-ghost">
              Import from a past briefing
            </a>
          </div>
        )}
        <Feedback state={addState} />
      </div>
    </div>
  );
}
