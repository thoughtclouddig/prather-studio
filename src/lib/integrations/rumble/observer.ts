/**
 * Rumble Live Stream API — OBSERVER ONLY.
 *
 * Rumble exposes no way to upload, edit metadata, list past videos, retrieve a
 * recording, or register a webhook. What it does expose is a poll-only JSON
 * endpoint at rumble.com/account/livestream-api that reports whether a stream
 * is live right now.
 *
 * So the Studio watches Rumble; it never drives it. Every state this module
 * writes is recorded as OBSERVED, never as published-by-us — see
 * `applyObservation`, which is explicit about that distinction in Activity.
 *
 * Two consequences of the API's design that shape this code:
 *   1. The URL itself is the credential (there is no header auth), so it is
 *      stored encrypted and never rendered.
 *   2. Everything under `livestreams` is populated ONLY while live. The moment
 *      a stream ends the array empties — there is no "it finished" event. End
 *      of stream is therefore inferred from the disappearance of a stream we
 *      were previously watching.
 */
import "server-only";
import { readCredential, type RumbleCredentialPayload } from "@/lib/integrations/credentials";

export interface RumbleLivestream {
  id: string | number;
  title: string;
  createdOn: string | null;
  isLive: boolean;
  watchingNow: number | null;
  likes: number | null;
  dislikes: number | null;
  categoryTitle: string | null;
  chatMessageCount: number;
  rantCount: number;
}

export interface RumbleObservation {
  observedAt: string;
  followers: number | null;
  followersTotal: number | null;
  subscribers: number | null;
  livestreams: RumbleLivestream[];
  /** The stream currently live, if any. */
  liveNow: RumbleLivestream | null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parse the documented response shape defensively — this is a v1 beta API. */
export function parseObservation(raw: unknown): RumbleObservation {
  const root = (raw ?? {}) as Record<string, any>;
  const streams: RumbleLivestream[] = Array.isArray(root["livestreams"])
    ? root["livestreams"].map((s: Record<string, any>) => ({
        id: s?.["id"] ?? "",
        title: String(s?.["title"] ?? ""),
        createdOn: s?.["created_on"] ? String(s["created_on"]) : null,
        isLive: Boolean(s?.["is_live"]),
        watchingNow: num(s?.["watching_now"]),
        likes: num(s?.["likes"]),
        dislikes: num(s?.["dislikes"]),
        categoryTitle: s?.["categories"]?.["primary"]?.["title"] ?? null,
        chatMessageCount: Array.isArray(s?.["chat"]?.["recent_messages"])
          ? s["chat"]["recent_messages"].length
          : 0,
        rantCount: Array.isArray(s?.["chat"]?.["recent_rants"])
          ? s["chat"]["recent_rants"].length
          : 0,
      }))
    : [];

  return {
    observedAt: new Date().toISOString(),
    followers: num(root["followers"]?.["num_followers"]),
    followersTotal: num(root["followers"]?.["num_followers_total"]),
    subscribers: num(root["subscribers"]?.["num_subscribers"]),
    livestreams: streams,
    liveNow: streams.find((s) => s.isLive) ?? null,
  };
}

export class RumbleNotConnectedError extends Error {
  constructor() {
    super(
      "Rumble is not connected. Generate a Live Stream API URL at " +
        "rumble.com/account/livestream-api and add it in Integrations.",
    );
    this.name = "RumbleNotConnectedError";
  }
}

/** Poll the API once. Throws if not connected or if Rumble is unreachable. */
export async function observe(): Promise<RumbleObservation> {
  const stored = await readCredential<RumbleCredentialPayload>("RUMBLE");
  if (!stored) throw new RumbleNotConnectedError();

  const response = await fetch(stored.payload.apiUrl, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    // Never echo the URL — it is the credential.
    throw new Error(`Rumble Live Stream API returned ${response.status}.`);
  }

  const body = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(
      "Rumble Live Stream API did not return JSON. The saved URL may be wrong or expired.",
    );
  }
  return parseObservation(json);
}

/** A connection test that proves the URL works without changing any state. */
export async function testConnection(apiUrl: string): Promise<RumbleObservation> {
  const response = await fetch(apiUrl, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      `Rumble returned ${response.status}. Check the URL copied from rumble.com/account/livestream-api.`,
    );
  }
  const json = (await response.json()) as unknown;
  const parsed = parseObservation(json);
  if (parsed.followers === null && parsed.livestreams.length === 0) {
    // Shape check: a valid response always carries a followers object.
    const root = (json ?? {}) as Record<string, unknown>;
    if (!("followers" in root) && !("livestreams" in root)) {
      throw new Error("That URL responded, but not with a Rumble Live Stream API payload.");
    }
  }
  return parsed;
}
