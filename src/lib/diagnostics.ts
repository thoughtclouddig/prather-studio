/**
 * Which job kinds are development diagnostics rather than production work.
 *
 * `ping` and `fail-test` earned their place while the queue was being proved:
 * you cannot trust retry, backoff and dead-lettering without a handler that
 * fails on purpose. But a production operating desk that still shows RUN
 * FAIL-TEST is describing its own test harness, and a permanently dead
 * `fail-test` job sitting in Needs Attention trains the operator to ignore
 * Needs Attention — which is exactly the signal that must stay trustworthy
 * once a real show processes itself.
 *
 * So the handlers and their tests stay. Only their prominence changes.
 *
 * `simulate.publication` is a stronger case. It writes PUBLISHED onto a
 * publication row without contacting anything, and its one surviving artefact
 * claimed an `audio_url` returned 404 — a fabricated failure for a fabricated
 * asset. With Buzzsprout becoming a real adapter, a simulated publish that
 * looks like a real one is actively misleading, so it is refused outside
 * development regardless of who enqueues it.
 */
import type { Job } from "@/db/schema";

/** Job kinds that exist only to exercise the queue. */
export const DIAGNOSTIC_JOB_KINDS: ReadonlySet<string> = new Set([
  "ping",
  "fail-test",
]);

/** Job kinds that fake a provider interaction. */
export const SIMULATED_JOB_KINDS: ReadonlySet<string> = new Set([
  "simulate.publication",
]);

export function isDiagnosticJob(kind: string): boolean {
  return DIAGNOSTIC_JOB_KINDS.has(kind) || SIMULATED_JOB_KINDS.has(kind);
}

/**
 * Is this a deployment where diagnostics may be run and displayed?
 *
 * Reads `APP_ENV` first so it agrees with the worker-environment guard: one
 * declaration decides both "may this worker claim jobs here" and "is this a
 * place where test handlers belong".
 */
export function diagnosticsEnabled(
  env: string | undefined = process.env["APP_ENV"] ?? process.env["NODE_ENV"],
): boolean {
  return !/^prod/i.test((env ?? "development").trim());
}

export class DiagnosticsDisabledError extends Error {
  constructor(kind: string) {
    super(
      `"${kind}" is a development diagnostic and cannot be run on this deployment. ` +
        "It exists to exercise the queue, not to do production work.",
    );
    this.name = "DiagnosticsDisabledError";
  }
}

/**
 * Filter the operator's default view.
 *
 * Diagnostics are hidden rather than deleted: a dead `fail-test` is still real
 * history, and silently removing rows from an audit surface would be a worse
 * habit than showing one extra row. The Jobs page keeps an explicit filter for
 * anyone who wants them back.
 */
export function hideDiagnostics<T extends Pick<Job, "kind">>(
  jobs: T[],
  include: boolean,
): T[] {
  return include ? jobs : jobs.filter((job) => !isDiagnosticJob(job.kind));
}

/**
 * Should this job be allowed to raise Needs Attention?
 *
 * A job that failed on purpose is not an operational problem, and a permanent
 * fake alarm is how real alarms stop being read.
 */
export function countsAsOperationalFailure(kind: string): boolean {
  return !isDiagnosticJob(kind);
}
