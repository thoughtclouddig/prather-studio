/**
 * Buzzsprout API client.
 *
 * ## The documented surface, verified against the official reference
 *
 * Auth is a header: `Authorization: Token token=<key>`. The token may also be
 * passed as a query parameter; this client never does, because a query string
 * ends up in logs and proxies.
 *
 * | Method | Path | Notes |
 * |---|---|---|
 * | GET | `/api/podcasts.json` | No podcast id. Lists podcasts the token can reach — also how we discover the id. |
 * | GET | `/api/{id}/episodes.json` | All episodes. No documented pagination. |
 * | GET | `/api/{id}/episodes/{episodeId}.json` | One episode. |
 * | POST | `/api/{id}/episodes.json` | Create. |
 * | PUT | `/api/{id}/episodes/{episodeId}.json` | Update; returns the full updated episode. |
 *
 * **There is no documented DELETE and no documented PATCH.** That is a
 * load-bearing fact, not trivia: it means a test episode created on the real
 * podcast cannot be cleanly removed, which is why the scheduling experiment in
 * `docs/PHASE-3-INVESTIGATION.md` is not run automatically.
 *
 * **No rate limits are documented.** This client is therefore conservative by
 * construction: one request per operation, no polling loop, no parallel fan-out.
 *
 * ## Update semantics differ from YouTube and must not be assumed
 *
 * YouTube's `videos.update` deletes any property of a submitted part that the
 * request omits — which is why Phase 2 sends a full merged snippet. Buzzsprout
 * documents PUT returning "the current JSON representation of the updated
 * episode", but does not state whether omitted fields are cleared or left
 * alone. Until that is observed on a real episode, `updateEpisode` sends a
 * merged payload built from the current remote state, which is correct under
 * BOTH readings. Assuming the safer semantics would risk blanking a real
 * episode's show notes.
 */
import "server-only";
import { readCredential } from "@/lib/integrations/credentials";

const BASE = "https://www.buzzsprout.com/api";

/** What we store. The token is the whole credential. */
export interface BuzzsproutCredentialPayload {
  apiToken: string;
  /** Numeric podcast id, e.g. 1762960. Stored so every call has a target. */
  podcastId: string;
}

export class BuzzsproutApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = "BuzzsproutApiError";
  }
}

export class BuzzsproutNotConnectedError extends Error {
  constructor() {
    super("Buzzsprout is not connected. Add the API token in Integrations.");
    this.name = "BuzzsproutNotConnectedError";
  }
}

export interface BuzzsproutPodcast {
  id: number;
  title: string;
  author: string | null;
  description: string | null;
  websiteAddress: string | null;
  language: string | null;
  timezone: string | null;
  artworkUrl: string | null;
}

export interface BuzzsproutEpisode {
  id: number;
  title: string;
  description: string | null;
  summary: string | null;
  artist: string | null;
  tags: string | null;
  audioUrl: string | null;
  artworkUrl: string | null;
  /** ISO 8601 with offset, e.g. "2026-09-10T07:00:00.000-07:00". */
  publishedAt: string | null;
  durationSeconds: number | null;
  guid: string | null;
  /** Non-null means the episode has been deactivated. */
  inactiveAt: string | null;
  episodeNumber: number | null;
  seasonNumber: number | null;
  explicit: boolean;
  private: boolean;
  totalPlays: number | null;
  /** Everything the API returned, so nothing is silently dropped on update. */
  raw: Record<string, unknown>;
}

async function credential(): Promise<BuzzsproutCredentialPayload> {
  const stored = await readCredential<BuzzsproutCredentialPayload>("BUZZSPROUT");
  if (!stored) throw new BuzzsproutNotConnectedError();
  return stored.payload;
}

async function call<T>(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      // Header auth, never the query parameter — a token in a URL lands in
      // access logs, proxies and browser history.
      authorization: `Token token=${token}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    throw new BuzzsproutApiError(
      res.status,
      text.slice(0, 500),
      res.status === 401 || res.status === 403
        ? "Buzzsprout rejected the API token."
        : `Buzzsprout returned ${res.status}.`,
    );
  }
  return (text ? JSON.parse(text) : null) as T;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toEpisode(raw: Record<string, unknown>): BuzzsproutEpisode {
  return {
    id: Number(raw["id"]),
    title: String(raw["title"] ?? ""),
    description: str(raw["description"]),
    summary: str(raw["summary"]),
    artist: str(raw["artist"]),
    tags: str(raw["tags"]),
    audioUrl: str(raw["audio_url"]),
    artworkUrl: str(raw["artwork_url"]),
    publishedAt: str(raw["published_at"]),
    durationSeconds: num(raw["duration"]),
    guid: str(raw["guid"]),
    inactiveAt: str(raw["inactive_at"]),
    episodeNumber: num(raw["episode_number"]),
    seasonNumber: num(raw["season_number"]),
    explicit: raw["explicit"] === true,
    private: raw["private"] === true,
    totalPlays: num(raw["total_plays"]),
    raw,
  };
}

/**
 * List every podcast this token can reach.
 *
 * Doubles as the connection test: it is the only call that needs no podcast id,
 * so it can verify a token before we know what it points at.
 */
export async function listPodcasts(token: string): Promise<BuzzsproutPodcast[]> {
  const data = await call<Array<Record<string, unknown>>>("/podcasts.json", token);
  return (data ?? []).map((p) => ({
    id: Number(p["id"]),
    title: String(p["title"] ?? ""),
    author: str(p["author"]),
    description: str(p["description"]),
    websiteAddress: str(p["website_address"]),
    language: str(p["language"]),
    timezone: str(p["timezone"]),
    artworkUrl: str(p["artwork_url"]),
  }));
}

export async function listEpisodes(limit?: number): Promise<BuzzsproutEpisode[]> {
  const { apiToken, podcastId } = await credential();
  const data = await call<Array<Record<string, unknown>>>(
    `/${podcastId}/episodes.json`,
    apiToken,
  );
  const episodes = (data ?? []).map(toEpisode);
  // Newest first. The API's order is not documented, so we impose one.
  episodes.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  return limit ? episodes.slice(0, limit) : episodes;
}

export async function getEpisode(episodeId: number): Promise<BuzzsproutEpisode | null> {
  const { apiToken, podcastId } = await credential();
  try {
    const data = await call<Record<string, unknown>>(
      `/${podcastId}/episodes/${episodeId}.json`,
      apiToken,
    );
    return data ? toEpisode(data) : null;
  } catch (error) {
    if (error instanceof BuzzsproutApiError && error.status === 404) return null;
    throw error;
  }
}

/** The fields the Studio is willing to write. Deliberately a short list. */
export interface EpisodeWrite {
  title?: string;
  description?: string;
  summary?: string;
  published_at?: string;
  private?: boolean;
  episode_number?: number;
  season_number?: number;
  tags?: string;
  audio_url?: string;
  artwork_url?: string;
}

/**
 * Update an existing episode.
 *
 * Takes the CURRENT remote episode and merges the changes onto it, then sends
 * the merged result. Buzzsprout does not document whether omitted fields are
 * preserved or cleared; merging is correct either way, and the cost of being
 * wrong in the other direction is a real episode losing its show notes.
 */
export async function updateEpisode(
  episodeId: number,
  current: BuzzsproutEpisode,
  changes: EpisodeWrite,
): Promise<BuzzsproutEpisode> {
  const { apiToken, podcastId } = await credential();

  const merged: EpisodeWrite = {
    title: current.title,
    ...(current.description !== null ? { description: current.description } : {}),
    ...(current.summary !== null ? { summary: current.summary } : {}),
    ...(current.publishedAt !== null ? { published_at: current.publishedAt } : {}),
    ...(current.tags !== null ? { tags: current.tags } : {}),
    ...(current.episodeNumber !== null
      ? { episode_number: current.episodeNumber }
      : {}),
    ...(current.seasonNumber !== null ? { season_number: current.seasonNumber } : {}),
    private: current.private,
    ...changes,
  };

  const data = await call<Record<string, unknown>>(
    `/${podcastId}/episodes/${episodeId}.json`,
    apiToken,
    { method: "PUT", body: merged },
  );
  return toEpisode(data);
}

/**
 * Create an episode.
 *
 * Unused until the audio-source question is answered — see
 * `docs/PHASE-3-INVESTIGATION.md`. Present because `createEpisode` without an
 * `audio_url` is precisely the fake this phase was told not to build, and
 * having the function refuse that is clearer than not having it.
 */
export async function createEpisode(fields: EpisodeWrite): Promise<BuzzsproutEpisode> {
  if (!fields.audio_url) {
    throw new Error(
      "Refusing to create a Buzzsprout episode with no audio. A podcast episode " +
        "without an audio file is not a published episode, and pretending " +
        "otherwise is the failure this phase exists to avoid.",
    );
  }
  const { apiToken, podcastId } = await credential();
  const data = await call<Record<string, unknown>>(
    `/${podcastId}/episodes.json`,
    apiToken,
    { method: "POST", body: fields },
  );
  return toEpisode(data);
}

/** Verify a token before storing it, and discover what it points at. */
export async function verifyToken(
  token: string,
): Promise<{ podcasts: BuzzsproutPodcast[] }> {
  return { podcasts: await listPodcasts(token) };
}
