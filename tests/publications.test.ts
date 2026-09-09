import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodePublications, jobs, type EpisodePublication, type User } from "@/db/schema";
import {
  enqueueSimulatedPublish,
  setPublicationIntent,
} from "@/lib/domain/publications";
import { claim } from "@/lib/queue/queue";
import { getHandler } from "@/lib/queue/handlers";
import { makeEpisode, makePublication, makeShow, makeUser, resetDb } from "./helpers";

let owner: User;
let episodeId: string;
let publication: EpisodePublication;

beforeEach(async () => {
  await resetDb();
  owner = await makeUser("OWNER");
  const show = await makeShow();
  episodeId = (await makeEpisode(show.id)).id;
  publication = await makePublication(episodeId, "YOUTUBE");
});

describe("publication intent", () => {
  it("defaults to PUBLISH / NOT_STARTED", () => {
    expect(publication.intent).toBe("PUBLISH");
    expect(publication.state).toBe("NOT_STARTED");
  });

  it("HOLD records the decision without touching state", async () => {
    const held = await setPublicationIntent(owner, publication.id, "HOLD");
    expect(held.intent).toBe("HOLD");
    expect(held.state).toBe("NOT_STARTED");
  });

  /**
   * The distinction the whole dashboard rests on: SKIP is a decision WITH an
   * outcome. It must never render as unfinished work, and it must never render
   * as a failure.
   */
  it("SKIP is its own outcome, and is reversible", async () => {
    const skipped = await setPublicationIntent(owner, publication.id, "SKIP");
    expect(skipped.intent).toBe("SKIP");
    expect(skipped.state).toBe("SKIPPED");

    const unskipped = await setPublicationIntent(owner, publication.id, "PUBLISH");
    expect(unskipped.intent).toBe("PUBLISH");
    expect(unskipped.state).toBe("NOT_STARTED");
  });

  it("a role without publication.intent cannot change it", async () => {
    const stranger = { ...owner, role: "VIEWER" as never };
    await expect(
      setPublicationIntent(stranger, publication.id, "SKIP"),
    ).rejects.toThrow();
  });

  it("only one publication row per (episode, platform) is possible", async () => {
    await expect(makePublication(episodeId, "YOUTUBE")).rejects.toThrow();
  });
});

describe("simulated dispatch", () => {
  it("queues a job and moves the publication to QUEUED", async () => {
    const { jobId } = await enqueueSimulatedPublish(owner, publication.id);

    const [pub] = await db
      .select()
      .from(episodePublications)
      .where(eq(episodePublications.id, publication.id));
    expect(pub?.state).toBe("QUEUED");

    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job?.kind).toBe("simulate.publication");
    expect(job?.episodeId).toBe(episodeId);
  });

  it("refuses to queue while intent is HOLD or SKIP", async () => {
    await setPublicationIntent(owner, publication.id, "HOLD");
    await expect(enqueueSimulatedPublish(owner, publication.id)).rejects.toThrow(
      /intent is HOLD/,
    );
  });

  it("running the handler publishes with an obviously fake URL", async () => {
    await enqueueSimulatedPublish(owner, publication.id);
    const [job] = await claim("test-worker");
    await getHandler(job!.kind)!(job!, { workerId: "test-worker" });

    const [pub] = await db
      .select()
      .from(episodePublications)
      .where(eq(episodePublications.id, publication.id));

    expect(pub?.state).toBe("PUBLISHED");
    // Nothing in this build may ever produce a resolvable platform URL.
    expect(pub?.externalUrl).toContain("simulated.invalid");
    expect(pub?.errorMessage).toBeNull();
  });

  /**
   * Locals has no write API. A capability-aware handler must stop at the
   * handoff instead of claiming a publish that cannot happen.
   */
  it("stops at AWAITING_MANUAL for a platform with no write API", async () => {
    const locals = await makePublication(episodeId, "LOCALS");
    await enqueueSimulatedPublish(owner, locals.id);

    const claimed = await claim("test-worker", 5);
    const job = claimed.find(
      (j) => (j.payload as { publicationId?: string }).publicationId === locals.id,
    );
    await getHandler(job!.kind)!(job!, { workerId: "test-worker" });

    const [pub] = await db
      .select()
      .from(episodePublications)
      .where(
        and(
          eq(episodePublications.episodeId, episodeId),
          eq(episodePublications.platform, "LOCALS"),
        ),
      );

    expect(pub?.state).toBe("AWAITING_MANUAL");
    expect(pub?.externalUrl).toBeNull();
    expect(pub?.publishedAt).toBeNull();
  });
});
