import { Fragment } from "react";
import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { episodes, jobs, type JobState } from "@/db/schema";
import { JOB_STATE_TONE } from "@/lib/domain/vocabulary";
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
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter } = await searchParams;
  const key = filter && FILTERS[filter] ? filter : "all";
  const states = FILTERS[key]!.states;

  const [rows, counts] = await Promise.all([
    db
      .select({ job: jobs, episodeTitle: episodes.workingTitle, episodeId: episodes.id })
      .from(jobs)
      .leftJoin(episodes, eq(episodes.id, jobs.episodeId))
      .where(inArray(jobs.state, states))
      .orderBy(desc(jobs.updatedAt))
      .limit(200),
    db.select({ state: jobs.state }).from(jobs),
  ]);

  const countFor = (s: JobState[]) =>
    counts.filter((c) => s.includes(c.state)).length;

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="eyebrow">Background processing</div>
          <h1 className="display text-[26px]">Jobs</h1>
        </div>
        <TestJobControls />
      </div>

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
            href={k === "all" ? "/studio/jobs" : `/studio/jobs?filter=${k}`}
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
