/**
 * Getting a generated image to the exact size a platform demands.
 *
 * ## Why this exists
 *
 * `gpt-image-1` renders 1024x1024, 1536x1024 or 1024x1536. **None of those is
 * 16:9**, and YouTube's thumbnail is 1920x1080. So the master is generated at
 * 1536x1024 (3:2) and brought to 1920x1080 here: a centred vertical crop to
 * 16:9, then a 1.25x upscale.
 *
 * The upscale is small enough to be invisible — 1536 to 1920 with a Lanczos
 * kernel on a photographic frame holds up. The crop is the part that costs
 * something: 160px of height, 80 from the top and 80 from the bottom. That is
 * why the prompt tells the model to keep the logo and headline inside a safe
 * area rather than against the edges.
 *
 * ## Why JPEG
 *
 * YouTube rejects thumbnails over 2 MB and the probe showed a LOW-quality
 * 1536x1024 PNG already weighs 1.5 MB. `encodeSmallest` steps quality down from
 * 92 and stops at the first size that fits, rather than fixing a number:
 * frames full of heavy blacks compress very differently from bright busy ones,
 * so a single quality setting is either wasteful on one or visibly degraded on
 * the other. mozjpeg encodes 15-20% smaller than standard libjpeg at the same
 * quality.
 */
import "server-only";
import sharp, { type Sharp } from "sharp";

/** YouTube: minimum 1280x720, maximum 2 MB. We deliver 1920x1080. */
export const MASTER = { width: 1920, height: 1080, maxBytes: 2_000_000 } as const;
/** Buzzsprout artwork and the WordPress featured image. */
export const SQUARE = { width: 1024, height: 1024, maxBytes: 1_000_000 } as const;

export interface FittedImage {
  bytes: Buffer;
  contentType: "image/jpeg";
  width: number;
  height: number;
  quality: number;
}

/**
 * Encode the smallest JPEG that still looks right.
 *
 * Stops at the first quality that fits, so a frame that compresses well keeps
 * its quality rather than being pushed down to meet a number it already met.
 * The floor is 74: below that, banding appears in the dark gradients these
 * images are full of and "smaller" stops being free.
 */
export async function encodeSmallest(
  image: Sharp,
  targetBytes: number,
): Promise<{ bytes: Buffer; quality: number }> {
  let last: Buffer | null = null;
  let lastQuality = 92;

  for (const quality of [92, 88, 84, 80, 76, 74]) {
    const bytes = await image
      .clone()
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:2:0" })
      .toBuffer();
    last = bytes;
    lastQuality = quality;
    if (bytes.length <= targetBytes) break;
  }

  return { bytes: last!, quality: lastQuality };
}

/**
 * 3:2 generated frame to an exact 1920x1080.
 *
 * `fit: cover` with a centred position crops the vertical and scales the rest,
 * which is the right operation: the alternative — squashing 1024 down to 1080's
 * aspect — would distort faces, and letterboxing would waste the frame.
 */
export async function fitMaster(generated: Buffer): Promise<FittedImage> {
  const image = sharp(generated).resize(MASTER.width, MASTER.height, {
    fit: "cover",
    position: "centre",
    kernel: "lanczos3",
  });

  const { bytes, quality } = await encodeSmallest(image, MASTER.maxBytes * 0.3);
  return {
    bytes,
    contentType: "image/jpeg",
    width: MASTER.width,
    height: MASTER.height,
    quality,
  };
}

/**
 * The square is generated at 1024x1024 already, so this is an encode rather
 * than a resize — but it still goes through `cover` so a frame generated at the
 * wrong size cannot silently ship at the wrong size.
 */
export async function fitSquare(generated: Buffer): Promise<FittedImage> {
  const image = sharp(generated).resize(SQUARE.width, SQUARE.height, {
    fit: "cover",
    position: "centre",
    kernel: "lanczos3",
  });

  const { bytes, quality } = await encodeSmallest(image, SQUARE.maxBytes * 0.4);
  return {
    bytes,
    contentType: "image/jpeg",
    width: SQUARE.width,
    height: SQUARE.height,
    quality,
  };
}

/** Read back what we actually produced, rather than trusting the request. */
export async function describe(bytes: Buffer): Promise<{
  width: number;
  height: number;
  format: string;
  bytes: number;
}> {
  const meta = await sharp(bytes).metadata();
  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    format: meta.format ?? "unknown",
    bytes: bytes.length,
  };
}
