"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { submitShowAction } from "./actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary w-full sm:w-auto" disabled={pending}>
      {pending ? "Sending…" : "Send to Andy"}
    </button>
  );
}

/**
 * The host's form.
 *
 * Four fields and a send button, the same shape Jeff already uses. The one
 * addition is a dedicated box for his own write-up — it used to be buried in
 * "anything else", which is a strange place to put the paragraph that becomes
 * the email.
 */
export function SubmitForm({ token, defaultDate }: { token: string; defaultDate: string }) {
  const [state, action] = useActionState(submitShowAction, undefined);

  if (state?.ok) {
    return (
      <div className="panel p-6 space-y-3">
        <div className="rail-val state-done">
          <span>Sent</span>
        </div>
        <p className="text-[15px] leading-relaxed">{state.ok}</p>
        <a href="." className="btn btn-ghost btn-xs">
          Submit another
        </a>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-5">
      {token && <input type="hidden" name="k" value={token} />}

      <label className="block">
        <span className="eyebrow block mb-1.5">Date — shows in the email</span>
        <input
          name="showDate"
          type="date"
          required
          defaultValue={defaultDate}
          className="field"
        />
      </label>

      <label className="block">
        <span className="eyebrow block mb-1.5">Your headline for today *</span>
        <input
          name="headline"
          type="text"
          required
          autoComplete="off"
          placeholder="Say it your way"
          className="field"
        />
        <span className="block text-[12px] text-[var(--color-type-lo)] mt-1.5 leading-snug">
          Write it however you want. We&rsquo;ll offer some inbox-friendly versions
          alongside it &mdash; yours stays on the list.
        </span>
      </label>

      <label className="block">
        <span className="eyebrow block mb-1.5">Today&rsquo;s show topics &mdash; one per line *</span>
        <textarea
          name="topics"
          required
          rows={9}
          placeholder={"One topic per line\nThey become the bullet list in the email and on the site"}
          className="field leading-relaxed"
        />
      </label>

      <label className="block">
        <span className="eyebrow block mb-1.5">Your write-up for the email</span>
        <textarea
          name="brief"
          rows={7}
          placeholder="A couple of paragraphs in your own voice — this is what people read before they click through."
          className="field leading-relaxed"
        />
        <span className="block text-[12px] text-[var(--color-type-lo)] mt-1.5 leading-snug">
          We proofread this rather than rewrite it. Your words go out.
        </span>
      </label>

      <label className="block">
        <span className="eyebrow block mb-1.5">
          Anything else? <span className="normal-case tracking-normal">(optional)</span>
        </span>
        <textarea name="notes" rows={3} className="field leading-relaxed" />
      </label>

      {state?.error && (
        <p className="text-[13px] text-[var(--color-signal-red)] leading-snug">{state.error}</p>
      )}

      <div className="pt-1">
        <Submit />
        <p className="text-[12px] text-[var(--color-type-lo)] mt-3 leading-relaxed">
          Andy gets it to review. Nothing sends until he approves it &mdash; sponsors and
          the watch link are set on his end.
        </p>
      </div>
    </form>
  );
}
