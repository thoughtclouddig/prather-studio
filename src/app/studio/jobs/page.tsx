import { Fragment } from "react";
import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { episodes, jobs, type JobState } from "@/db/schema";
import { JOB_STATE_TONE } from "@/lib/domain/vocabulary";
import { diagnosticsEnabled, hideDiagnostics, isDiagnosticJob } from "@/lib/diagnostics";
import { assessWorkers, listWorkers } from "@/lib/queue/worker-registry";
import { relative, stamp } from "@/lib/format";
import { Empty, Panel, StateBadge } from "@/components/ui";
import { RetryButton, TestJobControls } from "./parts";

export const dynamic = "force-dynamic";

const FILTERS: Record<string, { label: string; states: JobState[] }> = {
  active: { label: "Active", states: ["PENDING", "RUNNING"] },
  failed: { label: "Failed", states: ["FAILED"] },
  dead: { label: "Dead", states: ["DEAD"] },
  complete: { label: "Complete", states: ["SUCCEEDED"] },
  all: {
    label: "All",
    states: ["PENDING", "RUNNING", "FAILED", "DEAD", "SUCCEEDED"],
  },
};

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; diagnostics?: string }>;
}) {
  const { filter, diagnostics } = await searchParams;
  const key = filter && FILTERS[filter] ? filter : "all";
  const states = FILTERS[key]!.states;
  const showDiagnostics = diagnostics === "1";

  const [allRows, counts, workers] = await Promise.all([
    db
      .select({ job: jobs, episodeTitle: episodes.workingTitle, episodeId: episodes.id })
      .from(jobs)
      .leftJoin(episodes, eq(episodes.id, jobs.episodeId))
      .where(inArray(jobs.state, states))
      .orderBy(desc(jobs.updatedAt))
      .limit(200),
    db.select({ state: jobs.state, kind: jobs.kind }).from(jobs),
    listWorkers(),
  ]);

  // Diagnostics are hidden, never deleted -- a dead `fail-test` is still real
  // history, and quietly removing rows from an audit surface is a worse habit
  // than showing one extra row.
  const rows = hideDiagnostics(allRows.map((r) => ({ ...r, kind: r.job.kind })), showDiagnostics);
  const visibleCounts = hideDiagnostics(counts, showDiagnostics);
  const diagnosticCount = counts.filter((c) => isDiagnosticJob(c.kind)).length;

  const countFor = (s: JobState[]) =>
    visibleCounts.filter((c) => s.includes(c.state)).length;

  const concerns = assessWorkers(workers, process.env["REPLIT_DEPLOYMENT_ID"] ?? null)
    .concerns;
  const live = workers.filter((w) => w.alive);
  const href = (k: string) => {
    const params = new URLSearchParams();
    if (k !== "all") params.set("filter", k);
    if (showDiagnostics) params.set("diagnostics", "1");
    const q = params.toString();
    return q ? `/studio/jobs?${q}` : "/studio/jobs";
  };

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="eyebrow">Background processing</div>
          <h1 className="display text-[26px]">Jobs</h1>
        </div>
        {diagnosticsEnabled() && <TestJobControls />}
      </div>

      {/* Worker health. Phase 2 had four workers competing for the same jobs,
          two of them stale -- "is the worker running?" has to be answerable
          from here rather than by SSHing into the VM. */}
      <Panel>
        <div className="flex items-baseline justify-between gap-4 flex-wrap mb-3">
          <div className="eyebrow">Worker</div>
          <span
            className="text-[11px] font-bold uppercase tracking-[0.1em]"
            style={{
              color:
                live.length === 1 && concerns.length === 0
                  ? "var(--color-signal-green)"
                  : live.length === 0
                    ? "var(--color-signal-red)"
                    : "var(--color-signal-amber)",
            }}
          >
            {live.length === 0
              ? "NOT RUNNING"
              : live.length === 1
                ? "RUNNING"
                : `${live.length} RUNNING`}
          </span>
        </div>
        {workers.length === 0 ? (
          <Empty>
            No worker has ever registered against this database. Nothing will be
            processed automatically until one starts.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Environment</th>
                  <th className="hidden lg:table-cell">Version</th>
                  <th>Last beat</th>
                  <th className="text-right">Claimed</th>
                </tr>
              </thead>
              <tbody>
                {workers.map((w) => (
                  <tr key={w.workerId}>
                    <td className="mono whitespace-nowrap">
                      <span
                        aria-hidden="true"
                        className="inline-block w-2 h-2 mr-2 align-middle"
                        style={{
                          background: w.alive
                            ? "var(--color-signal-green)"
                            : "var(--color-ink-400)",
                        }}
                      />
                      {w.workerId}
                    </td>
                    <td className="mono text-[12px]">{w.environment}</td>
                    <td className="mono text-[12px] hidden lg:table-cell">
                      {w.version ?? "—"}
                    </td>
                    <td className="mono text-[12px] whitespace-nowrap">
                      {w.alive ? `${w.secondsSinceBeat}s ago` : relative(w.lastBeatAt)}
                    </td>
                    <td className="mono text-right">{w.jobsClaimed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {concerns.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {concerns.map((c) => (
              <li
                key={c}
                className="flex gap-2 text-[12px] leading-relaxed text-[var(--color-signal-amber)]"
              >
                <span aria-hidden="true" className="flex-none">&#9632;</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="text-[12px] text-[var(--color-type-lo)] max-w-[760px] leading-relaxed">
        Jobs run on a separate always-on worker, not inside a web request.{" "}
        <strong className="text-[var(--color-type-mid)]">Failed</strong> means an
        attempt failed and a retry is scheduled;{" "}
        <strong className="text-[var(--color-type-mid)]">Dead</strong> means the
        attempts ran out and it is waiting on a person.
      </p>

      <nav className="flex flex-wrap border border-[var(--color-ink-200)] bg-[var(--color-ink-050)]">
        {Object.entries(FILTERS).map(([k, f]) => (
          <Link
            key={k}
            href={href(k)}
            className={[
              "px-4 py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] border-r border-[var(--color-ink-200)] last:border-r-0 transition-colors",
              k === key
                ? "bg-[var(--color-ink-150)] text-[var(--color-type-hi)]"
                : "text-[var(--color-type-lo)] hover:text-[var(--color-type-hi)]",
            ].join(" ")}
          >
            {f.label}
            <span className="ml-2 font-mono text-[var(--color-type-lo)]">
              {countFor(f.states)}
            </span>
          </Link>
        ))}
        {diagnosticCount > 0 && (
          <Link
            href={
              showDiagnostics
                ? href(key).replace(/[?&]diagnostics=1/, "").replace(/\?$/, "") ||
                  "/studio/jobs"
                : `${href(key).includes("?") ? `${href(key)}&` : `${href(key)}?`}diagnostics=1`
            }
            className={[
              "px-4 py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] border-l border-[var(--color-ink-200)] ml-auto transition-colors",
              showDiagnostics
                ? "bg-[var(--color-ink-150)] text-[var(--color-type-hi)]"
                : "text-[var(--color-type-lo)] hover:text-[var(--color-type-hi)]",
            ].join(" ")}
          >
            Diagnostics
            <span className="ml-2 font-mono">{diagnosticCount}</span>
          </Link>
        )}
      </nav>

      <Panel>
        {rows.length === 0 ? (
          <Empty>No jobs in this state.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Episode</th>
                  <th>State</th>
                  <th>Attempt</th>
                  <th className="hidden lg:table-cell">Created</th>
                  <th>Last run</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ job, episodeTitle, episodeId }) => (
                  <Fragment key={job.id}>
                  <tr className={job.lastError ? "[&>td]:border-b-0" : ""}>
                    <td className="mono whitespace-nowrap font-semibold">{job.kind}</td>
                    <td className="text-[12px] max-w-[220px]">
                      {episodeId ? (
                        <Link
                          href={`/studio/episodes/${episodeId}`}
                          className="link truncate block"
                        >
                          {episodeTitle}
                        </Link>
                      ) : (
                        <span className="text-[var(--color-type-lo)]">—</span>
                      )}
                    </td>
                    <td>
                      <StateBadge tone={JOB_STATE_TONE[job.state]} label={job.state} />
                    </td>
                    <td className="mono">
                      {job.attempts}/{job.maxAttempts}
                    </td>
                    <td className="mono whitespace-nowrap hidden lg:table-cell">
                      {stamp(job.createdAt)}
                    </td>
                    <td className="mono whitespace-nowrap">
                      {job.finishedAt
                        ? relative(job.finishedAt)
                        : job.state === "FAILED"
                          ? `retry ${relative(job.runAfter)}`
                          : "—"}
                    </td>
                    <td className="text-right">
                      {(job.state === "DEAD" || job.state === "FAILED") && (
                        <RetryButton jobId={job.id} />
                      )}
                    </td>
                  </tr>
                  {job.lastError && (
                    <tr>
                      <td colSpan={7} className="pt-0">
                        <div className="flex gap-2 text-[12px] leading-relaxed text-[var(--color-signal-red)]">
                          <span aria-hidden="true" className="flex-none">&#8627;</span>
                          <span>{job.lastError}</span>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
