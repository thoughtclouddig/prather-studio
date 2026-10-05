/**
 * Compositing the finished thumbnail.
 *
 * Artwork comes from the image model with no text in it at all. Everything
 * readable — the logo, the tagline, the headline — is laid on here as real
 * glyphs. That is what makes the spelling reliable and the logo identical
 * between episodes.
 *
 * ## How the type is drawn
 *
 * Satori renders the text block to SVG with `embedFont`, which converts glyphs
 * to `<path>` elements. That matters operationally: the rendered SVG carries no
 * font reference, so nothing has to be installed on the host for sharp to
 * rasterize it. A missing font would otherwise fail silently as blank space or
 * a substituted face, on a server nobody is watching.
 *
 * ## Why JPEG, and why the quality is searched rather than fixed
 *
 * YouTube rejects thumbnails over **2 MB**. A low-quality 1536x1024 generation
 * already weighs 1.5 MB as PNG, so PNG was never viable at 1920x1080.
 *
 * Rather than guess a quality number, `encodeSmallest` starts high and steps
 * down until the file fits a target, then stops. Photographic frames with heavy
 * blacks compress very differently from bright busy ones, so a fixed quality is
 * either wasteful on one and visibly degraded on the other. mozjpeg does the
 * encoding; at these sizes it lands 15-20% under libjpeg for the same quality.
 */
import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import satori from "satori";
import sharp, { type Sharp } from "sharp";

/**
 * Satori accepts React-element-shaped objects, but typing them as ReactNode
 * drags JSX into a module that renders no components. These are plain objects
 * describing a layout, so they are declared as such and cast at the boundary.
 */
type Node = { type: string; props: Record<string, unknown> };
const node = (n: Node) => n as unknown as React.ReactNode;

const BRAND = path.join(process.cwd(), "public", "brand");

/** The show's palette, matching the logo and the Studio. */
const INK = "#0b0b0d";
const WHITE = "#f4f4f4";
const RED = "#d81f2a";

export interface CompositeRequest {
  artwork: Buffer;
  /** The approved headline. Rendered as type, never drawn by a model. */
  headline: string;
  tagline?: string;
  width: number;
  height: number;
}

let cachedFont: Buffer | null = null;
let cachedLogo: Buffer | null = null;

async function displayFont(): Promise<Buffer> {
  cachedFont ??= await readFile(path.join(BRAND, "fonts", "Anton-Regular.ttf"));
  return cachedFont;
}
async function logo(): Promise<Buffer> {
  cachedLogo ??= await readFile(path.join(BRAND, "prather-point-logo.png"));
  return cachedLogo;
}

/**
 * Split a headline into lines that fill the type column.
 *
 * Longer headlines get smaller type rather than more lines — four lines of a
 * condensed face at thumbnail size is unreadable, which is the failure the
 * reference artwork avoids by keeping the headline short and enormous.
 */
export function layoutHeadline(
  headline: string,
  columnWidth = 883,
  availableHeight = 700,
): { lines: string[]; fontSize: number } {
  const words = headline
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase()
    .replace(/[.]$/, "")
    .split(" ");

  // Greedy wrap to a character budget, the way a typesetter would, rather than
  // splitting into equal word-counts. Equal chunks produced "MIKE ADAMS / ON
  // DATA / CENTER DANGERS!" — breaks that fall in the middle of a phrase and
  // read as a mistake.
  // The budget scales with the headline, so a short one gets SHORT lines and
  // therefore enormous type. A fixed budget made "FIVE BASES HIT" render at the
  // same size as a sixty-character headline, which is the opposite of what the
  // reference artwork does — there, the shorter the line, the louder it is.
  const totalLength = words.join(" ").length;
  const budget = totalLength <= 16 ? 9 : totalLength <= 28 ? 12 : 15;
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= budget || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  // A line of one short connector ("ON", "AND") reads as a typo. Pull it up.
  for (let i = lines.length - 1; i > 0; i--) {
    if (lines[i]!.length <= 3 && lines[i - 1]!.length + lines[i]!.length < budget + 4) {
      lines[i - 1] = `${lines[i - 1]} ${lines[i]}`;
      lines.splice(i, 1);
    }
  }

  // Size to the ACTUAL column, not to a character count.
  //
  // The first version used a ratio tuned by eye, and the renderer quietly
  // soft-wrapped whenever it guessed high — so a layout that claimed three
  // lines rendered as four. It looked fine by luck, which is worse than
  // looking wrong, because nothing said the number of lines was a guess.
  //
  // ANTON_WIDTH_RATIO is the average advance width of an uppercase glyph in
  // Anton as a fraction of the font size, measured from rendered output. It is
  // deliberately a named constant: swapping the display face changes it, and a
  // face with different metrics would otherwise reintroduce the same silent
  // wrapping.
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const usable = columnWidth * 0.88; // the column minus its padding
  const byWidth = Math.floor(usable / (longest * ANTON_WIDTH_RATIO));
  const byHeight = Math.floor((availableHeight * 0.95) / Math.max(lines.length, 1) / 0.9);

  return {
    lines,
    fontSize: Math.max(44, Math.min(byWidth, byHeight, 168)),
  };
}

/** Average uppercase advance width in Anton, as a fraction of font size. */
const ANTON_WIDTH_RATIO = 0.46;

/** The text layer: logo, tagline, headline. Transparent everywhere else. */
async function typeLayer(
  request: CompositeRequest,
  columnWidth: number,
): Promise<Buffer> {
  const font = await displayFont();
  const { lines, fontSize } = layoutHeadline(
    request.headline,
    columnWidth,
    request.height * 0.62,
  );

  const svg = await satori(
    node({
      type: "div",
      props: {
        style: {
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          justifyContent: "flex-end",
          padding: `${Math.round(request.height * 0.05)}px ${Math.round(columnWidth * 0.06)}px`,
        },
        children: lines.map((line, i) => ({
          type: "div",
          props: {
            style: {
              fontFamily: "Display",
              fontSize,
              // The last line in red, as the reference does — it carries the
              // payload of the headline and the eye lands there.
              color: i === lines.length - 1 && lines.length > 1 ? RED : WHITE,
              lineHeight: 0.9,
              letterSpacing: "-0.005em",
              textShadow: `0 ${Math.round(fontSize * 0.03)}px ${Math.round(fontSize * 0.08)}px rgba(0,0,0,0.85)`,
            },
            children: line,
          },
        })),
      },
    }),
    {
      width: columnWidth,
      height: request.height,
      fonts: [{ name: "Display", data: font, weight: 400, style: "normal" }],
      embedFont: true,
    },
  );

  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Encode the smallest JPEG that still looks right.
 *
 * Steps quality down from 92 and stops at the first size that fits. The floor
 * is 74 — below that, compression artefacts appear in the dark gradients these
 * images are full of, and "smaller" stops being free.
 */
export async function encodeSmallest(
  image: Sharp,
  targetBytes = 420_000,
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

/** The 16:9 thumbnail: artwork, logo, tagline, headline. */
export async function compositeLandscape(
  request: CompositeRequest,
): Promise<{ bytes: Buffer; contentType: string; quality: number }> {
  const { width, height } = request;

  // The model renders 3:2; 16:9 is a centred vertical crop. The prompt keeps
  // the subject centre-right and the left quiet, so this takes sky and floor.
  const base = sharp(request.artwork).resize(width, height, {
    fit: "cover",
    position: "centre",
  });

  const columnWidth = Math.round(width * 0.46);
  const text = await typeLayer(request, columnWidth);

  // A gradient scrim under the type. Without it a headline sits on whatever
  // the model happened to paint, and contrast is luck rather than design.
  const scrim = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
       <defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="0">
         <stop offset="0%" stop-color="${INK}" stop-opacity="0.92"/>
         <stop offset="55%" stop-color="${INK}" stop-opacity="0.68"/>
         <stop offset="100%" stop-color="${INK}" stop-opacity="0"/>
       </linearGradient></defs>
       <rect width="${Math.round(width * 0.62)}" height="${height}" fill="url(#s)"/>
     </svg>`,
  );

  const logoWidth = Math.round(width * 0.22);
  const logoPng = await sharp(await logo())
    .resize({ width: logoWidth })
    .png()
    .toBuffer();
  const logoMeta = await sharp(logoPng).metadata();

  const margin = Math.round(width * 0.028);
  const composed = base.composite([
    { input: scrim, top: 0, left: 0 },
    { input: logoPng, top: margin, left: margin },
    ...(request.tagline
      ? [
          {
            input: await taglineStrip(request.tagline, logoWidth),
            top: margin + (logoMeta.height ?? 0) + Math.round(height * 0.012),
            left: margin,
          },
        ]
      : []),
    { input: text, top: 0, left: 0 },
  ]);

  const { bytes, quality } = await encodeSmallest(composed);
  return { bytes, contentType: "image/jpeg", quality };
}

async function taglineStrip(tagline: string, width: number): Promise<Buffer> {
  const font = await displayFont();
  const svg = await satori(
    node({
      type: "div",
      props: {
        style: { display: "flex", width: "100%" },
        children: {
          type: "div",
          props: {
            style: {
              fontFamily: "Display",
              fontSize: Math.round(width * 0.082),
              color: WHITE,
              letterSpacing: "0.22em",
              opacity: 0.9,
            },
            children: tagline.toUpperCase(),
          },
        },
      },
    }),
    {
      width,
      height: Math.round(width * 0.14),
      fonts: [{ name: "Display", data: font, weight: 400, style: "normal" }],
      embedFont: true,
    },
  );
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * The square companion: the artwork, reframed. No type at all.
 *
 * This is the whole payoff of generating text-free artwork — the "same
 * subjects, same background, same lighting" the hand-written prompt asked a
 * model to reproduce is here by construction, because it is the same file.
 */
export async function compositeSquare(
  artwork: Buffer,
  size = 1024,
): Promise<{ bytes: Buffer; contentType: string; quality: number }> {
  const square = sharp(artwork).resize(size, size, {
    fit: "cover",
    // Attention-biased rather than centred: a centre crop of a 3:2 frame whose
    // subject sits centre-right would cut the subject in half.
    position: sharp.strategy.attention,
  });
  const { bytes, quality } = await encodeSmallest(square, 260_000);
  return { bytes, contentType: "image/jpeg", quality };
}
