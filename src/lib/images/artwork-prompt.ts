/**
 * Building the artwork prompt.
 *
 * ## What changed from the prompt that was being used by hand
 *
 * The working ChatGPT prompt asked one model to do two jobs: paint the scene,
 * AND render the headline, logo and tagline as type. It contained the line
 * "Spell every word correctly", which is the tell — image models misspell, and
 * that instruction existed because it kept happening.
 *
 * So the division here is: **the model paints, the Studio sets type.** The
 * prompt below deliberately forbids ALL text, and the logo, tagline and
 * approved headline are composited afterwards as real glyphs. That gives three
 * things the single-prompt approach cannot:
 *
 *  · spelling is never wrong, because the headline is the draft a human
 *    already approved, placed as text rather than drawn;
 *  · the logo is pixel-identical every episode instead of re-imagined;
 *  · changing the headline costs a re-composite, not a regeneration.
 *
 * It also makes the square companion free. The original prompt asked for a
 * second image that preserved "the SAME subjects, background, lighting,
 * atmosphere, colour grading, weather, smoke, sparks, scenery" — an elaborate
 * request to reproduce something. Here the square simply IS the artwork,
 * reframed, because the text was never burned into it.
 *
 * ## The house style, preserved verbatim in spirit
 *
 * The style paragraph is carried over from the working prompt because it is
 * what makes these look like film posters rather than YouTube graphics, and it
 * is the part that was already right.
 */

/** The look. Carried over from the prompt that was already producing results. */
const HOUSE_STYLE = `Dramatic cinematic movie-poster composition. Photorealistic subjects. \
Extremely high contrast with deep blacks. Dramatic directional lighting. Storm clouds, \
smoke, and sparks or embers where they suit the subject. Rich red, white and blue \
accents. Gritty distressed textures. A premium political/news/thriller documentary \
aesthetic — it should read as a theatrical poster, never as a flat news graphic or a \
generic YouTube thumbnail.`;

/**
 * The prohibition. Stated at length and repeated because image models are
 * strongly inclined to add captions to anything poster-shaped, and a single
 * stray word ruins an otherwise usable frame.
 */
const NO_TEXT = `ABSOLUTELY NO TEXT OF ANY KIND anywhere in the image. No headline, no \
title, no caption, no label, no watermark, no logo, no lettering on signs, screens, \
banners, chyrons or clothing. No letters, no numbers, no glyphs. If the scene would \
naturally contain signage, render it blank or obscured. The image is a wordless \
painting; all typography is added afterwards.`;

/**
 * Composition. The left third is left deliberately quiet because that is where
 * the headline and logo land — this is why the reference thumbnails read so
 * well at small sizes, and the model has to be told or it centres everything.
 */
const COMPOSITION_16_9 = `Composition: 16:9 landscape. Keep the LEFT 40-45% of the frame \
visually calm — darker, less detailed, no important subject matter — because type is \
placed there later. Main subjects dominate the CENTRE and RIGHT. Build strong \
foreground, middle ground and background depth. Keep faces and key objects large \
enough to read at thumbnail size. Avoid small decorative detail that disappears when \
the image is shown two inches wide.`;

const COMPOSITION_1_1 = `Composition: 1:1 square. The principal subject is large and \
prominent and centred. Recompose the scene intelligently for a square frame rather \
than cropping a widescreen one — keep the same subjects, environment, lighting, \
atmosphere, colour grading and weather, but arrange them for the square.`;

export interface ArtworkRequest {
  /** The approved headline. Informs the scene; never rendered into it. */
  headline: string;
  /** Guest name, when the episode has one. Jeff is never depicted. */
  guestName?: string | null;
  /** True when a guest photo is supplied as a visual reference. */
  hasGuestPhoto?: boolean;
  aspect: "16:9" | "1:1";
  /** Operator steer on a regeneration — "darker", "lose the flag", etc. */
  note?: string | null;
}

export function buildArtworkPrompt(request: ArtworkRequest): string {
  const parts: string[] = [];

  parts.push(
    `Artwork for an episode of The Prather Point, an intelligence and current-affairs ` +
      `broadcast. The episode is about: "${request.headline}".`,
  );

  if (request.guestName) {
    parts.push(
      request.hasGuestPhoto
        ? `The guest is ${request.guestName}, shown in the supplied reference photograph. ` +
          `Render that person faithfully — the same face, build and likeness — placed into ` +
          `this scene with the lighting and grade described below. Do not substitute a ` +
          `different person and do not idealise or alter their features.`
        : `The episode features a guest, ${request.guestName}. No reference photograph was ` +
          `supplied, so do NOT attempt to depict them — an invented likeness of a real ` +
          `person is worse than none. Build the image from the subject matter instead.`,
    );
  } else {
    // Jeff is deliberately never depicted. Without a guest the image carries
    // the topic, which is also what the operator asked for.
    parts.push(
      `There is no guest. Do NOT depict any identifiable real person. Build the image ` +
        `entirely from the subject matter of the headline — the places, objects, symbols ` +
        `and atmosphere it implies.`,
    );
  }

  parts.push(HOUSE_STYLE);
  parts.push(request.aspect === "16:9" ? COMPOSITION_16_9 : COMPOSITION_1_1);
  parts.push(NO_TEXT);

  if (request.note?.trim()) {
    parts.push(`Additional direction from the operator: ${request.note.trim()}`);
  }

  return parts.join("\n\n");
}

/** Pixel dimensions per aspect. 16:9 is YouTube's thumbnail spec. */
export const ARTWORK_SIZES = {
  "16:9": { width: 1536, height: 864 },
  "1:1": { width: 1024, height: 1024 },
} as const;

/** What YouTube accepts: 1280x720 minimum, under 2 MB. We render at 1920x1080. */
export const THUMBNAIL_16_9 = { width: 1920, height: 1080 } as const;
export const THUMBNAIL_1_1 = { width: 1024, height: 1024 } as const;
