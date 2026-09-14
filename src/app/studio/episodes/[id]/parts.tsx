"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import type {
  EpisodeContentDraft,
  EpisodePublication,
  PublicationIntent,
} from "@/db/schema";
import {
  DRAFT_STATE_LABEL,
  DRAFT_STATE_TONE,
  fieldLabel,
  INTENT_LABEL,
  PLATFORM_LABEL,
  PUBLICATION_STATE_LABEL,
  PUBLICATION_STATE_TONE,
} from "@/lib/domain/vocabulary";
import { StateBadge, SimTag } from "@/components/ui";
import { relative, toShowInputValue } from "@/lib/format";
import {
  approveDraftAction,
  editApproveDraftAction,
  rejectDraftAction,
  setIntentAction,
  simulateQueueAction,
  type ActionState,
} from "@/app/studio/actions";

function Pending({ children, className = "btn btn-xs", ...rest }: React.ComponentProps<"button">) {
  const { pending } = useFormStatus();
  return (
    <button {...rest} className={className} disabled={pending || rest.disabled}>
      {pending ? "…" : children}
    </button>
  );
}

function ErrorLine({ state }: { state: ActionState }) {
  if (!state?.error) return null;
  return (
    <p className="text-[11px] text-[var(--color-signal-red)] mt-1.5">{state.error}</p>
  );
}

/* ------------------------------------------------------------------ draft */

export function DraftCard({
  draft,
  episodeId,
  canReview,
  compact = false,
}: {
  draft: EpisodeContentDraft;
  episodeId: string;
  canReview: boolean;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [approveState, approve] = useActionState(approveDraftAction, undefined);
  const [rejectState, reject] = useActionState(rejectDraftAction, undefined);
  const [editState, editApprove] = useActionState(editApproveDraftAction, undefined);

  const open = draft.state === "PROPOSED";
  const approved = draft.state === "APPROVED";

  return (
    <article
      className={[
        "border-l-2 pl-3.5 py-3 pr-3",
        approved
          ? "border-[var(--color-signal-green)] bg-[#0d1512]"
          : open
            ? "border-[var(--color-signal-amber)] bg-[var(--color-ink-100)]"
            : "border-[var(--color-ink-300)] bg-transparent opacity-70",
      ].join(" ")}
    >
      <header className="flex items-start justify-between gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="eyebrow">{fieldLabel(draft.field)}</span>
          {draft.platform && <span className="tag">{PLATFORM_LABEL[draft.platform]}</span>}
          <StateBadge
            tone={DRAFT_STATE_TONE[draft.state]}
            label={DRAFT_STATE_LABEL[draft.state]}
          />
        </div>
        <span className="mono">
          {draft.source === "AI" ? draft.model ?? "ai" : draft.source.toLowerCase()}
          {draft.approvedAt ? ` · approved ${relative(draft.approvedAt)}` : ""}
        </span>
      </header>

      {editing ? (
        <form action={editApprove} className="space-y-2">
          <input type="hidden" name="draftId" value={draft.id} />
          <input type="hidden" name="episodeId" value={episodeId} />
          <textarea
            name="value"
            defaultValue={draft.value}
            rows={Math.min(16, Math.max(3, draft.value.split("\n").length + 1))}
            className="field font-[inherit]"
          />
          <div className="flex gap-2">
            <Pending className="btn btn-xs btn-approve">Save &amp; approve</Pending>
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
          <ErrorLine state={editState} />
        </form>
      ) : (
        <p
          className={[
            "whitespace-pre-wrap leading-relaxed",
            compact ? "text-[13px]" : "text-[14px]",
            draft.state === "SUPERSEDED" || draft.state === "REJECTED"
              ? "line-through decoration-[var(--color-type-lo)] text-[var(--color-type-mid)]"
              : "",
          ].join(" ")}
        >
          {draft.value}
        </p>
      )}

      {!editing && canReview && open && (
        <div className="flex flex-wrap gap-2 mt-3">
          <form action={approve}>
            <input type="hidden" name="draftId" value={draft.id} />
            <input type="hidden" name="episodeId" value={episodeId} />
            <Pending className="btn btn-xs btn-approve">Approve</Pending>
          </form>
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => setEditing(true)}
          >
            Edit &amp; approve
          </button>
          <form action={reject}>
            <input type="hidden" name="draftId" value={draft.id} />
            <input type="hidden" name="episodeId" value={episodeId} />
            <Pending className="btn btn-xs btn-reject">Reject</Pending>
          </form>
          <ErrorLine state={approveState ?? rejectState} />
        </div>
      )}
    </article>
  );
}

/* ------------------------------------------------------------ publication */

const INTENTS: PublicationIntent[] = ["PUBLISH", "HOLD", "SKIP"];

export function PublicationRow({
  publication,
  episodeId,
  canEdit,
  note,
  /**
   * Whether this platform has a real adapter. A SIMULATE button beside a
   * genuinely connected provider invites exactly the confusion Phase 3 §2 set
   * out to remove: a simulated publish writes PUBLISHED without contacting
   * anything, and next to a real YouTube row that is actively misleading.
   */
  isReal = false,
  allowSimulation = true,
}: {
  publication: EpisodePublication;
  episodeId: string;
  canEdit: boolean;
  note?: string;
  isReal?: boolean;
  allowSimulation?: boolean;
}) {
  const [intentState, changeIntent] = useActionState(setIntentAction, undefined);
  const [simState, simulate] = useActionState(simulateQueueAction, undefined);

  return (
    <tr>
      <td className="w-[140px] align-top">
        <div className="text-[13px] font-bold">{PLATFORM_LABEL[publication.platform]}</div>
        {note && (
          <div className="text-[11px] text-[var(--color-type-lo)] mt-0.5 leading-snug">
            {note}
          </div>
        )}
      </td>

      <td className="w-[200px] align-top">
        <form action={changeIntent} className="flex">
          <input type="hidden" name="publicationId" value={publication.id} />
          <input type="hidden" name="episodeId" value={episodeId} />
          {INTENTS.map((intent) => {
            const on = publication.intent === intent;
            return (
              <button
                key={intent}
                type="submit"
                name="intent"
                value={intent}
                disabled={!canEdit}
                className={[
                  "px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] border border-[var(--color-ink-300)] -ml-px first:ml-0 transition-colors",
                  on
                    ? intent === "SKIP"
                      ? "bg-[var(--color-ink-300)] text-[var(--color-type-hi)]"
                      : intent === "HOLD"
                        ? "bg-[#2a2210] text-[var(--color-signal-amber)] border-[#6d5a1f]"
                        : "bg-[#12241a] text-[#6fd39c] border-[#2a6a4a]"
                    : "text-[var(--color-type-lo)] hover:text-[var(--color-type-hi)] disabled:hover:text-[var(--color-type-lo)]",
                ].join(" ")}
              >
                {INTENT_LABEL[intent]}
              </button>
            );
          })}
        </form>
        <ErrorLine state={intentState} />
      </td>

      <td className="w-[150px] align-top">
        <StateBadge
          tone={PUBLICATION_STATE_TONE[publication.state]}
          label={PUBLICATION_STATE_LABEL[publication.state]}
        />
        <div className="mono mt-1">
          {publication.lastSyncAt ? `synced ${relative(publication.lastSyncAt)}` : "never synced"}
        </div>
      </td>

      <td className="align-top">
        {publication.externalUrl ? (
          <a
            href={publication.externalUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="link mono break-all"
          >
            {publication.externalUrl}
          </a>
        ) : (
          <span className="mono">—</span>
        )}
        {publication.errorMessage && (
          <div className="mt-1 text-[11px] text-[var(--color-signal-red)] leading-snug">
            {publication.errorMessage}
          </div>
        )}
        {simState?.ok && (
          <div className="mt-1 text-[11px] text-[var(--color-signal-amber)]">
            {simState.ok}
          </div>
        )}
        <ErrorLine state={simState} />
      </td>

      <td className="w-[170px] align-top text-right">
        {isReal ? (
          <span className="mono text-[11px]">real adapter</span>
        ) : !allowSimulation ? (
          <span className="mono text-[11px]">no adapter yet</span>
        ) : (
          canEdit && (
          <form action={simulate} className="inline-flex flex-col items-end gap-1">
            <input type="hidden" name="publicationId" value={publication.id} />
            <input type="hidden" name="episodeId" value={episodeId} />
            <Pending
              className="btn btn-xs"
              disabled={publication.intent !== "PUBLISH"}
              title={
                publication.intent !== "PUBLISH"
                  ? "Set intent to Publish first"
                  : "Queues a simulation job — no platform is contacted"
              }
            >
              Simulate queue
            </Pending>
            <SimTag />
          </form>
          )
        )}
      </td>
    </tr>
  );
}

/* ---------------------------------------------------------------- episode */

export function EpisodeForm({
  episode,
  canEdit,
  action,
}: {
  episode: {
    id: string;
    workingTitle: string;
    phase: string;
    showPrepState: string;
    artworkState: string;
    internalNotes: string | null;
    scheduledAt: Date | null;
  };
  canEdit: boolean;
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, submit] = useActionState(action, undefined);

  // Shown and submitted in SHOW time so the air slot cannot drift.
  const showTimeValue = toShowInputValue(episode.scheduledAt);

  return (
    <form action={submit} className="p-4 grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="episodeId" value={episode.id} />

      <label className="sm:col-span-2">
        <span className="eyebrow block mb-1.5">Working title</span>
        <input
          name="workingTitle"
          defaultValue={episode.workingTitle}
          className="field"
          disabled={!canEdit}
        />
      </label>

      <label>
        <span className="eyebrow block mb-1.5">Scheduled (show time, ET)</span>
        <input
          type="datetime-local"
          name="scheduledAt"
          defaultValue={showTimeValue}
          className="field"
          disabled={!canEdit}
        />
      </label>

      <label>
        <span className="eyebrow block mb-1.5">Phase</span>
        <select name="phase" defaultValue={episode.phase} className="field" disabled={!canEdit}>
          {["PLANNED","SCHEDULED","LIVE","CAPTURING","PRODUCING","REVIEW","RELEASED","ARCHIVED"].map(
            (p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ),
          )}
        </select>
      </label>

      <label>
        <span className="eyebrow block mb-1.5">Show prep</span>
        <select
          name="showPrepState"
          defaultValue={episode.showPrepState}
          className="field"
          disabled={!canEdit}
        >
          {["PENDING", "READY"].map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span className="eyebrow block mb-1.5">Artwork</span>
        <select
          name="artworkState"
          defaultValue={episode.artworkState}
          className="field"
          disabled={!canEdit}
        >
          {["MISSING", "PENDING", "READY"].map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>

      <label className="sm:col-span-2">
        <span className="eyebrow block mb-1.5">Internal notes</span>
        <textarea
          name="internalNotes"
          defaultValue={episode.internalNotes ?? ""}
          rows={3}
          className="field"
          disabled={!canEdit}
        />
      </label>

      {canEdit && (
        <div className="sm:col-span-2 flex items-center gap-3">
          <Pending className="btn btn-primary">Save episode</Pending>
          {state?.ok && (
            <span className="text-[11px] text-[var(--color-signal-green)]">{state.ok}</span>
          )}
          {state?.error && (
            <span className="text-[11px] text-[var(--color-signal-red)]">{state.error}</span>
          )}
        </div>
      )}
    </form>
  );
}
