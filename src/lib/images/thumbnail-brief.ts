/**
 * The thumbnail brief, for pasting into the working ChatGPT thread.
 *
 * ## Why this is a prompt to copy rather than an API call
 *
 * The API route was built and abandoned on evidence. The thumbnails produced
 * through `/v1/images` were poor; the ones produced by pasting this brief into
 * an existing ChatGPT thread are excellent, every week, without fail.
 *
 * The difference is not the wording. That thread carries months of previous
 * thumbnails, so the model is mirroring real examples rather than reading an
 * adjective list. A single reference image in an API call is a weak imitation
 * of that, and no amount of tuning closes the gap.
 *
 * So the Studio does not try to out-generate a process that already works. It
 * removes the four steps around it: it fills in the approved headline, hands
 * over the exact text to paste, takes the two files back, and does everything
 * downstream — YouTube thumbnail, podcast artwork, WordPress featured image.
 *
 * ## This text is the operator's, not ours
 *
 * It is reproduced as written, with only the topic, headline and slug
 * substituted. Nothing here should be "improved" without the operator asking:
 * it is tuned against a thread that responds to it, and an edit that reads
 * better in isolation can quietly change what comes back.
 */

export interface ThumbnailBrief {
  /** The approved headline. Used for topic, headline and the filenames. */
  headline: string;
  /** Used for the output filenames, e.g. `iraq-israeli-false-flag`. */
  slug: string;
}

/** `Iraq Israeli False Flag War` → `iraq-israeli-false-flag-war` */
export function slugFor(headline: string): string {
  return (
    headline
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "episode"
  );
}

export function buildThumbnailBrief(input: ThumbnailBrief): string {
  const { headline } = input;
  const slug = input.slug || slugFor(headline);

  return `Create TWO separate image files for this Prather Point podcast episode.

EPISODE TOPIC:
**${headline}**

HEADLINE:
**${headline}**

REFERENCE STYLE:
Use the established Prather Point thumbnail style we've been using: dramatic cinematic movie-poster composition, photorealistic subjects, extremely high contrast, deep blacks, dramatic directional lighting, storm clouds, smoke, sparks/embers where appropriate, rich red/white/blue accents, gritty distressed textures, and a premium political/news/thriller documentary aesthetic.
Do not make it look like a generic YouTube thumbnail or flat news graphic.

IMPORTANT: Create the following as TWO SEPARATE FILES.

FILE 1 — MASTER THUMBNAIL
Exactly 1920 × 1080 pixels, 16:9.
Include:
• The Prather Point logo in the upper-left.
• The tagline "FREEDOM IS TAKEN" beneath the logo.
• Large, extremely readable headline typography on the LEFT side.
• Use condensed, distressed, bold uppercase typography.
• Headline should occupy roughly 40–45% of the composition.
• Use red, white, and occasional gold/yellow emphasis.
• Main subjects should dominate the CENTER and RIGHT.
• Keep important faces and objects large enough to read at thumbnail size.
• Create strong foreground / middle ground / background depth.
• Avoid tiny decorative elements that will disappear at small sizes.
• Do not change or paraphrase the supplied headline.
• Spell every word correctly.
The overall result should feel like a theatrical political thriller/documentary poster rather than a conventional podcast graphic.

FILE 2 — SQUARE SUBJECTS VERSION
Exactly 1024 × 1024 pixels.
This MUST be a companion image derived from the SAME visual concept as File 1.
CRITICAL:
• NO headline.
• NO typography.
• NO Prather Point logo.
• NO tagline.
• NO captions or labels.
• NO additional text anywhere.
• Preserve the SAME subjects.
• Preserve the SAME background/environment.
• Preserve the SAME lighting, atmosphere, color grading, weather, smoke, sparks, scenery, and overall visual storytelling.
• Do NOT invent a different background.
• Do NOT introduce unrelated people or objects.
• Recompose the original scene intelligently for 1:1 rather than simply cropping the 16:9 image.
• Make the principal subject(s) large and prominent.
• Retain the most important secondary visual elements from the 1920×1080 master.
• It should immediately look like the text-free square companion to the master thumbnail.

CONSISTENCY RULE:
Someone viewing the two files side-by-side should immediately recognize that they belong to the exact same episode and were created from the same underlying artwork.

OUTPUT:
1. ${slug}-1920x1080.png
2. ${slug}-1024x1024.png

Return them as TWO SEPARATE image files.`;
}

/** What the operator is expected to bring back, and what each is used for. */
export const EXPECTED_FILES = [
  {
    kind: "THUMBNAIL_16_9" as const,
    label: "Master — 1920 × 1080",
    usedFor: "YouTube thumbnail",
  },
  {
    kind: "THUMBNAIL_1_1" as const,
    label: "Square — 1024 × 1024",
    usedFor: "Podcast artwork and the WordPress featured image",
  },
];
