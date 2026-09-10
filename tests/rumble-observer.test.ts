import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { activityEvents, episodePublications, episodes } from "@/db/schema";
import { parseObservation } from "@/lib/integrations/rumble/observer";
import { applyRumbleObservation } from "@/lib/domain/linkage";
import { makeEpisode, makePublication, makeShow, resetDb } from "./helpers";
import { db as database } from "@/db/client";

/** The documented shape of a Rumble Live Stream API response. */
const RAW_LIVE = {
  now: 1_757_000_000,
  type: "user",
  user_id: 12345,
  followers: { num_followers: 40, num_followers_total: 512_000, recent_followers: [] },
  subscribers: { num_subscribers: 1_200, recent_subscribers: [] },
  livestreams: [
    {
      id: "v6abcxy",
      title: "The Prather Point LIVE",
      created_on: "2026-09-10T18:00:00+00:00",
      is_live: true,
      categories: { primary: { slug: "news", title: "News" } },
      likes: 812,
      dislikes: 9,
      watching_now: 3_140,
      chat: {
        recent_messages: [{ username: "a", text: "hi" }, { username: "b", text: "yo" }],
        recent_rants: [{ username: "c", text: "!", amount_cents: 500 }],
      },
    },
  ],
};

const RAW_IDLE = { ...RAW_LIVE, livestreams: [] };

let showId: string;

beforeEach(async () => {
  await resetDb();
  showId = (await makeShow()).id;
});

describe("parsing the Rumble payload", () => {
  it("reads the documented fields", () => {
    const observation = parseObservation(RAW_LIVE);
    expect(observation.followersTotal).toBe(512_000);
    expect(observation.subscribers).toBe(1_200);
    expect(observation.liveNow?.title).toBe("The Prather Point LIVE");
    expect(observation.liveNow?.watchingNow).toBe(3_140);
    expect(observation.liveNow?.likes).toBe(812);
    expect(observation.liveNow?.categoryTitle).toBe("News");
    expect(observation.liveNow?.chatMessageCount).toBe(2);
    expect(observation.liveNow?.rantCount).toBe(1);
  });

  /**
   * Rumble empties `livestreams` the moment a broadcast ends — there is no
   * "finished" event. An empty array is the normal idle state, not an error.
   */
  it("treats an empty livestreams array as nothing live", () => {
    expect(parseObservation(RAW_IDLE).liveNow).toBeNull();
  });

  it("survives a payload missing fields entirely", () => {
    const observation = parseObservation({});
    expect(observation.liveNow).toBeNull();
    expect(observation.followers).toBeNull();
    expect(observation.livestreams).toEqual([]);
  });
});

describe("applying an observation to the schedule", () => {
  async function scheduledEpisodeNow() {
    const episode = await makeEpisode(showId);
    await database
      .update(episodes)
      .set({ scheduledAt: new Date(), phase: "SCHEDULED" })
      .where(eq(episodes.id, episode.id));
    await makePublication(episode.id, "RUMBLE");
    await makePublication(episode.id, "YOUTUBE");
    return episode.id;
  }

  it("advances the matching episode to LIVE", async () => {
    const episodeId = await scheduledEpisodeNow();
    const result = await applyRumbleObservation(parseObservation(RAW_LIVE));

    expect(result.matchedEpisodeId).toBe(episodeId);
    expect(result.transition).toBe("LIVE");

    const [pub] = await db
      .select()
      .from(episodePublications)
      .where(
        and(
          eq(episodePublications.episodeId, episodeId),
          eq(episodePublications.platform, "RUMBLE"),
        ),
      );
    expect(pub!.state).toBe("LIVE");
    expect(pub!.externalId).toBe("v6abcxy");

    const [episode] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
    expect(episode!.phase).toBe("LIVE");
  });

  /**
   * The Studio did not publish this. If Activity ever stops saying so, the
   * distinction between what we did and what we watched is lost.
   */
  it("records the transition as OBSERVED, not published", async () => {
    await scheduledEpisodeNow();
    await applyRumbleObservation(parseObservation(RAW_LIVE));

    const [event] = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.verb, "rumble.observed_live"));

    expect(event).toBeDefined();
    expect(event!.summary).toContain("OBSERVED");
    expect(event!.summary).toContain("did not publish");
    expect(event!.after).toMatchObject({ observed: true });
  });

  it("makes an unmatched live stream a Needs Attention item, not a guess", async () => {
    const result = await applyRumbleObservation(parseObservation(RAW_LIVE));
    expect(result.matchedEpisodeId).toBeNull();
    expect(result.needsAttention).toContain("no scheduled episode");
  });

  /** Two candidates must never resolve automatically. */
  it("refuses to choose between two nearby episodes", async () => {
    await scheduledEpisodeNow();
    await scheduledEpisodeNow();

    const result = await applyRumbleObservation(parseObservation(RAW_LIVE));
    expect(result.matchedEpisodeId).toBeNull();
    expect(result.needsAttention).toContain("2 episodes are scheduled nearby");

    const live = await db
      .select()
      .from(episodePublications)
      .where(eq(episodePublications.state, "LIVE"));
    expect(live).toHaveLength(0);
  });

  it("infers the end of the show when the stream disappears", async () => {
    const episodeId = await scheduledEpisodeNow();
    await applyRumbleObservation(parseObservation(RAW_LIVE));

    const result = await applyRumbleObservation(parseObservation(RAW_IDLE));
    expect(result.transition).toBe("ENDED");

    const [pub] = await db
      .select()
      .from(episodePublications)
      .where(
        and(
          eq(episodePublications.episodeId, episodeId),
          eq(episodePublications.platform, "RUMBLE"),
        ),
      );
    expect(pub!.state).toBe("PUBLISHED");
    expect(pub!.publishedAt).not.toBeNull();

    const [episode] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
    expect(episode!.phase).toBe("PRODUCING");
    expect(episode!.airedAt).not.toBeNull();
  });

  it("re-observing the same live stream does not duplicate anything", async () => {
    const episodeId = await scheduledEpisodeNow();
    await applyRumbleObservation(parseObservation(RAW_LIVE));
    const second = await applyRumbleObservation(parseObservation(RAW_LIVE));

    expect(second.matchedEpisodeId).toBe(episodeId);
    expect(second.transition).toBeNull();

    const events = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.verb, "rumble.observed_live"));
    expect(events).toHaveLength(1);
  });

  it("an idle poll with nothing tracked is a no-op", async () => {
    const result = await applyRumbleObservation(parseObservation(RAW_IDLE));
    expect(result).toEqual({ matchedEpisodeId: null, needsAttention: null, transition: null });
  });
});
