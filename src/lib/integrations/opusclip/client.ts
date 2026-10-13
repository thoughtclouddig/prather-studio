/**
 * OpusClip — long recording in, short vertical clips out.
 *
 * ## Shapes verified against their OpenAPI spec, not guessed
 *
 * `POST /api/clip-projects` takes `videoUrl` and nothing else as required.
 * Work is asynchronous: the response is a project with a `stage`, and the
 * clips arrive later. `conclusionActions` is how you ask to be told — a
 * WEBHOOK entry with a URL, which is why this does not poll.
 *
 * ## There is no virality score
 *
 * Their marketing leads with one; `ExportableClipRepresentation` does not
 * contain it. What a clip actually carries is a title, a description,
 * hashtags, keywords, its transcript text and its time ranges. Worth knowing
 * before building a UI around a number that is not in the payload.
 *
 * ## STREAM_YARD is a source platform
 *
 * `sourcePlatform` enumerates STREAM_YARD alongside YOUTUBE and UPLOADED.
 * Not used here — we send a YouTube or Rumble URL — but it is a thread worth
 * remembering, since StreamYard is where these shows originate.
 */
import "server-only";
import { readCredential } from "@/lib/integrations/credentials";

const API = "https://api.opus.pro";

export interface OpusCredentialPayload {
  apiKey: string;
  /** The sk-… secret that signs webhooks. Separate from the API key. */
  signingSecret?: string | null;
}

/** Their pipeline, in order. COMPLETE and STALLED are the terminal two. */
export type OpusStage =
  | "PENDING"
  | "QUEUED"
  | "IMPORT"
  | "CURATE"
  | "REFINE"
  | "RENDER"
  | "UPLOAD"
  | "COMPLETE"
  | "STALLED";

export class OpusApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpusApiError";
  }
}

export class OpusNotConnectedError extends Error {
  constructor() {
    super("OpusClip is not connected. Add the API key in Integrations.");
    this.name = "OpusNotConnectedError";
  }
}

async function credential(): Promise<OpusCredentialPayload> {
  const stored = await readCredential<OpusCredentialPayload>("OPUSCLIP");
  if (!stored) throw new OpusNotConnectedError();
  return stored.payload;
}

async function call<T>(
  path: string,
  apiKey: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    cache: "no-store",
  });

  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* fall through to the status */
  }

  if (!res.ok) {
    const detail =
      (typeof body["message"] === "string" && body["message"]) ||
      (typeof body["error"] === "string" && body["error"]) ||
      text.slice(0, 300);
    throw new OpusApiError(
      res.status,
      res.status === 401
        ? "OpusClip rejected that API key."
        : res.status === 402
          ? "OpusClip reports no credits left on this account."
          : `OpusClip returned ${res.status}: ${detail}`,
    );
  }

  return body as T;
}

export interface OpusProject {
  id: string;
  projectId: string;
  stage: OpusStage;
  sourcePlatform: string | null;
  error: string | null;
}

function toProject(raw: Record<string, unknown>): OpusProject {
  return {
    id: String(raw["id"] ?? ""),
    projectId: String(raw["projectId"] ?? raw["id"] ?? ""),
    stage: (raw["stage"] as OpusStage) ?? "PENDING",
    sourcePlatform:
      typeof raw["sourcePlatform"] === "string" ? raw["sourcePlatform"] : null,
    error: typeof raw["error"] === "string" ? raw["error"] : null,
  };
}

export interface CreateProjectInput {
  videoUrl: string;
  /** Where OpusClip should call back when it finishes. */
  webhookUrl: string;
  /** [min, max] seconds per clip. Their field is an array of pairs. */
  clipDurations?: Array<[number, number]>;
  /** Steers ClipBasic towards what the show is actually about. */
  topicKeywords?: string[];
}

/**
 * Start a clipping run.
 *
 * `notifyFailure` is on deliberately: without it a run that dies is a webhook
 * that never arrives, which is indistinguishable from one still working.
 */
export async function createClipProject(input: CreateProjectInput): Promise<OpusProject> {
  const c = await credential();

  const data = await call<Record<string, unknown>>("/api/clip-projects", c.apiKey, {
    method: "POST",
    body: {
      videoUrl: input.videoUrl,
      conclusionActions: [
        { type: "WEBHOOK", url: input.webhookUrl, notifyFailure: true },
      ],
      curationPref: {
        ...(input.clipDurations ? { clipDurations: input.clipDurations } : {}),
        ...(input.topicKeywords?.length ? { topicKeywords: input.topicKeywords } : {}),
        enableAutoHook: true,
      },
    },
  });

  return toProject(data);
}

/** Read a project back. Used when a webhook is missed or arrives out of order. */
export async function getProject(projectId: string): Promise<OpusProject> {
  const c = await credential();
  return toProject(await call<Record<string, unknown>>(`/api/clip-projects/${projectId}`, c.apiKey));
}

export interface OpusClip {
  id: string;
  title: string;
  description: string | null;
  /** The clip's own transcript. */
  text: string | null;
  hashtags: string | null;
  keywords: string[];
  durationSeconds: number;
  previewUrl: string | null;
  downloadUrl: string | null;
}

function toClip(raw: Record<string, unknown>): OpusClip {
  const ms = Number(raw["durationMs"] ?? 0);
  return {
    id: String(raw["id"] ?? ""),
    title: String(raw["title"] ?? ""),
    description: typeof raw["description"] === "string" ? raw["description"] : null,
    text: typeof raw["text"] === "string" ? raw["text"] : null,
    hashtags: typeof raw["hashtags"] === "string" ? raw["hashtags"] : null,
    keywords: Array.isArray(raw["keywords"]) ? (raw["keywords"] as string[]) : [],
    durationSeconds: Number.isFinite(ms) ? Math.round(ms / 1000) : 0,
    previewUrl: typeof raw["uriForPreview"] === "string" ? raw["uriForPreview"] : null,
    downloadUrl: typeof raw["uriForExport"] === "string" ? raw["uriForExport"] : null,
  };
}

/**
 * The finished clips for a project.
 *
 * `q` is required by their spec even when filtering by project, so it is sent
 * empty rather than omitted — leaving it out returns a 400 that says nothing
 * about which parameter was missing.
 */
export async function listClips(projectId: string, pageSize = 50): Promise<OpusClip[]> {
  const c = await credential();
  const query = new URLSearchParams({
    q: "",
    projectId,
    pageSize: String(pageSize),
  });
  const data = await call<Record<string, unknown>>(
    `/api/exportable-clips?${query.toString()}`,
    c.apiKey,
  );

  const rows =
    (Array.isArray(data["data"]) && (data["data"] as Record<string, unknown>[])) ||
    (Array.isArray(data["items"]) && (data["items"] as Record<string, unknown>[])) ||
    (Array.isArray(data["results"]) && (data["results"] as Record<string, unknown>[])) ||
    [];

  return rows.map(toClip);
}

/**
 * Check a key without spending a credit.
 *
 * Creating a project would start a billable run, so this reads brand
 * templates instead — an authenticated GET that costs nothing.
 */
export async function verifyKey(apiKey: string): Promise<void> {
  await call("/api/brand-templates", apiKey);
}
