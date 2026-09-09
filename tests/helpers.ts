import { db, sql } from "@/db/client";
import {
  episodePublications,
  episodes,
  shows,
  users,
  type Episode,
  type Show,
  type User,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";

export async function resetDb(): Promise<void> {
  await sql`TRUNCATE TABLE
    activity_events, jobs, episode_content_drafts, episode_publications,
    episodes, sponsors, shows, sessions, users, settings
    RESTART IDENTITY CASCADE`;
}

let counter = 0;
const unique = () => `${Date.now()}-${counter++}`;

export async function makeUser(role: "OWNER" | "EDITOR"): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({
      email: `${role.toLowerCase()}-${unique()}@test.local`,
      name: role === "OWNER" ? "Test Owner" : "Test Editor",
      role,
      passwordHash: await hashPassword("correct-horse-battery"),
    })
    .returning();
  return user!;
}

export async function makeShow(): Promise<Show> {
  const [show] = await db
    .insert(shows)
    .values({ slug: `show-${unique()}`, name: "The Prather Point" })
    .returning();
  return show!;
}

export async function makeEpisode(showId: string): Promise<Episode> {
  const [episode] = await db
    .insert(episodes)
    .values({
      showId,
      slug: `episode-${unique()}`,
      workingTitle: "Working title",
      phase: "REVIEW",
    })
    .returning();
  return episode!;
}

export async function makePublication(
  episodeId: string,
  platform: "YOUTUBE" | "BUZZSPROUT" | "LOCALS" | "RUMBLE" = "YOUTUBE",
) {
  const [pub] = await db
    .insert(episodePublications)
    .values({ episodeId, platform })
    .returning();
  return pub!;
}
