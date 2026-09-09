"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { signIn } from "./actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary w-full py-2.5" disabled={pending}>
      {pending ? "Checking…" : "Sign in"}
    </button>
  );
}

export function LoginForm() {
  const [state, action] = useActionState(signIn, {});
  return (
    <form action={action} className="panel p-5 space-y-4">
      <div>
        <label htmlFor="email" className="eyebrow block mb-1.5">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          className="field"
        />
      </div>
      <div>
        <label htmlFor="password" className="eyebrow block mb-1.5">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="field"
        />
      </div>
      {state?.error && (
        <p className="text-[12px] text-[var(--color-signal-red)]">{state.error}</p>
      )}
      <Submit />
    </form>
  );
}
