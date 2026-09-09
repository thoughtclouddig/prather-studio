/**
 * Append-only activity log.
 *
 * Every meaningful mutation writes one row. Nothing updates or deletes these —
 * the log is the record of who did what, and it is what makes the state model
 * tangible in the Studio.
 */
import { db } from "@/db/client";
import { activityEvents } from "@/db/schema";

export type Actor =
  | { kind: "user"; id: string; name: string }
  | { kind: "system"; label: string };

export interface ActivityInput {
  actor: Actor;
  verb: string;
  subjectType: string;
  subjectId?: string | null;
  summary: string;
  episodeId?: string | null;
  before?: unknown;
  after?: unknown;
}

export async function recordActivity(
  input: ActivityInput,
  tx: Pick<typeof db, "insert"> = db,
): Promise<void> {
  await tx.insert(activityEvents).values({
    episodeId: input.episodeId ?? null,
    actorUserId: input.actor.kind === "user" ? input.actor.id : null,
    actorLabel: input.actor.kind === "user" ? input.actor.name : input.actor.label,
    verb: input.verb,
    subjectType: input.subjectType,
    subjectId: input.subjectId ?? null,
    summary: input.summary,
    before: (input.before ?? null) as never,
    after: (input.after ?? null) as never,
  });
}

export const SYSTEM_ACTOR: Actor = { kind: "system", label: "system" };
export const workerActor = (id: string): Actor => ({
  kind: "system",
  label: `worker:${id}`,
});
