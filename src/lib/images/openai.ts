/**
 * Image generation via OpenAI.
 *
 * The only non-Anthropic model in the stack, and deliberately so: there is no
 * Anthropic image model, and `gpt-image-1` is what produced the reference
 * thumbnails this is being built to reproduce. It is confined to this file —
 * nothing else in the Studio knows an image came from OpenAI.
 *
 * ## Two endpoints, because a guest changes the job
 *
 *  · No guest, or a guest with no photo → `/v1/images/generations`. A scene
 *    painted from the subject matter.
 *  · Guest with a photo → `/v1/images/edits`, with the photo as input. This is
 *    what carries a real person's likeness into the scene rather than inventing
 *    one, which is the whole reason the upload exists.
 *
 * ## Sizes
 *
 * `gpt-image-1` renders 1024x1024, 1536x1024 or 1024x1536. **None of those is
 * 16:9.** So a landscape frame is generated at 1536x1024 (3:2) and cropped to
 * 1536x864 when composited. The prompt keeps the left 40-45% quiet and the
 * subject centre-right, so a centred vertical crop loses only sky and floor —
 * but it is a real constraint and not a rounding error, and anyone changing
 * these numbers should know the crop exists.
 */
import "server-only";

const API = "https://api.openai.com/v1";
export const IMAGE_MODEL = "gpt-image-1";

/** What the API will actually render. Not the same as what we composite to. */
export type OpenAiSize = "1024x1024" | "1536x1024" | "1024x1536";

export class ImageGenerationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

export class ImageProviderNotConfiguredError extends Error {
  constructor() {
    super(
      "OPENAI_API_KEY is not set, so artwork cannot be generated. Everything " +
        "else in the Studio works without it.",
    );
    this.name = "ImageProviderNotConfiguredError";
  }
}

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new ImageProviderNotConfiguredError();
  return key;
}

export interface GeneratedImage {
  bytes: Buffer;
  contentType: string;
  /** What was actually rendered, before any crop. */
  width: number;
  height: number;
  model: string;
}

const DIMENSIONS: Record<OpenAiSize, { width: number; height: number }> = {
  "1024x1024": { width: 1024, height: 1024 },
  "1536x1024": { width: 1536, height: 1024 },
  "1024x1536": { width: 1024, height: 1536 },
};

async function readResponse(res: Response, size: OpenAiSize): Promise<GeneratedImage> {
  const text = await res.text();

  if (!res.ok) {
    let message = `OpenAI returned ${res.status}.`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
      if (parsed.error?.message) message = parsed.error.message;
      // Worth naming: this one is an account setting, not a code problem, and
      // the generic message sends people looking in the wrong place.
      if (parsed.error?.code === "unsupported_value" || /verif/i.test(message)) {
        message +=
          " — gpt-image-1 requires a verified OpenAI organisation. Check " +
          "platform.openai.com/settings/organization/general.";
      }
    } catch {
      message = `${message} ${text.slice(0, 200)}`;
    }
    throw new ImageGenerationError(res.status, message);
  }

  const body = JSON.parse(text) as { data?: Array<{ b64_json?: string }> };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) {
    throw new ImageGenerationError(200, "OpenAI returned no image data.");
  }

  return {
    bytes: Buffer.from(b64, "base64"),
    contentType: "image/png",
    ...DIMENSIONS[size],
    model: IMAGE_MODEL,
  };
}

/** Paint a scene from a prompt. No reference image. */
export async function generateArtwork(
  prompt: string,
  size: OpenAiSize,
  quality: "low" | "medium" | "high" = "high",
): Promise<GeneratedImage> {
  const res = await fetch(`${API}/images/generations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt,
      size,
      quality,
      n: 1,
      // Transparent would be wrong here: these are full-bleed photographic
      // scenes, and a transparent background would composite as black edges.
      background: "opaque",
      output_format: "png",
    }),
  });
  return readResponse(res, size);
}

/**
 * Paint a scene around a supplied photograph.
 *
 * The photo is a likeness reference, not a background to paint over. The prompt
 * does the work of saying so; this just carries the bytes.
 */
export async function generateArtworkFromPhoto(
  prompt: string,
  photo: { bytes: Buffer; contentType: string; filename: string },
  size: OpenAiSize,
  quality: "low" | "medium" | "high" = "high",
): Promise<GeneratedImage> {
  const form = new FormData();
  form.append("model", IMAGE_MODEL);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("quality", quality);
  form.append("n", "1");
  form.append(
    "image[]",
    new Blob([new Uint8Array(photo.bytes)], { type: photo.contentType }),
    photo.filename,
  );

  const res = await fetch(`${API}/images/edits`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey()}` },
    body: form,
  });
  return readResponse(res, size);
}

/** Is generation available at all? Used to disable the UI honestly. */
export function imageGenerationConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY?.trim();
}
