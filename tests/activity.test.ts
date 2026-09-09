import { beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { activityEvents, episodeContentDrafts, type User } from "@/db/schema";
import { approveDraft, editAndApproveDraft, rejectDraft } from "@/lib/domain/drafts";
import { setPublicationIntent } from "@/lib/domain/publications";
import { updateEpisode } from "@/lib/domain/episodes";
import { enqueue, claim, fail, retry } from "@/lib/queue/queue";
import { makeEpisode, makePublication, makeShow, makeUser, resetDb } from "./helpers";

let owner: User;
let episodeId: string;

const verbs = async (): Promise<string[]> => {
  const rows = await db
    .select({ verb: activityEvents.verb })
    .from(activityEvents)
    .orderBy(desc(activityEvents.createdAt));
  return rows.map((r) => r.verb);
};

beforeEach(async () => {
  await resetDb();
  owner = await makeUser("OWNER");
  const show = await makeShow();
  episodeId = (await makeEpisode(show.id)).id;
});

async function seedDraft() {
  const [draft] = await db
    .insert(episodeContentDrafts)
    .values({
      episodeId,
      field: "primary_headline",
      value: "A headline",
      source: "AI",
      state: "PROPOSED",
    })
    .returning();
  return draft!;
}

/**
 * The activity log is the record of who did what. If a meaningful mutation
 * stops writing to it, the audit trail silently develops a hole — so each
 * mutation is asserted individually rather than in bulk.
 */
describe("activity log", () => {
  it("records episode edits with before and after", async () => {
    await updateEpisode(owner, episodeId, { workingTitle: "Changed title" });

    const [event] = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.verb, "episode.updated"));

    expect(event).toBeDefined();
    expect(event?.actorUserId).toBe(owner.id);
    expect(event?.actorLabel).toBe(owner.name);
    expect(event?.after).toMatchObject({ workingTitle: "Changed title" });
  });

  it("writes nothing when an edit changes nothing", async () => {
    await updateEpisode(owner, episodeId, { workingTitle: "Working title" });
    expect(await verbs()).toHaveLength(0);
  });

  it("records approvals, rejections and edit-approvals", async () => {
    await approveDraft(owner, (await seedDraft()).id);
    await rejectDraft(owner, (await seedDraft()).id);
    await editAndApproveDraft(owner, (await seedDraft()).id, "Operator wording");

    expect(await verbs()).toEqual(
      expect.arrayContaining([
        "draft.approved",
        "draft.rejected",
        "draft.edited_and_approved",
      ]),
    );
  });

  it("records publication intent changes", async () => {
    const pub = await makePublication(episodeId, "BUZZSPROUT");
    await setPublicationIntent(owner, pub.id, "SKIP");

    const [event] = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.verb, "publication.intent_changed"));

    expect(event?.summary).toContain("Buzzsprout");
    expect(event?.before).toMatchObject({ intent: "PUBLISH" });
    expect(event?.after).toMatchObject({ intent: "SKIP" });
  });

  it("records the job lifecycle, including the manual retry and its actor", async () => {
    const { job } = await enqueue({
      kind: "fail-test",
      idempotencyKey: "activity-1",
      episodeId,
      maxAttempts: 1,
    });
    const [claimed] = await claim("worker-a");
    await fail(claimed!.id, "boom");
    await retry(job.id, { kind: "user", id: owner.id, name: owner.name });

    const all = await verbs();
    expect(all).toEqual(
      expect.arrayContaining(["job.enqueued", "job.dead", "job.retried"]),
    );

    const [retried] = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.verb, "job.retried"));
    expect(retried?.actorUserId).toBe(owner.id);
  });

  it("attaches events to their episode so the workspace can show them", async () => {
    await approveDraft(owner, (await seedDraft()).id);
    const rows = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.episodeId, episodeId));
    expect(rows.length).toBeGreaterThan(0);
  });
});
