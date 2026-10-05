/**
 * The thumbnail prompt.
 *
 * This is the prompt that has been producing The Prather Point's thumbnails
 * every week, carried over close to verbatim. It is not a reconstruction.
 *
 * ## Why it renders its own type
 *
 * The first version of this file split the job — model paints the scene, the
 * Studio sets the headline as real glyphs — on the theory that image models
 * misspell and that compositing would guarantee correct text and an identical
 * logo. The theory is sound and the result was worse: flat vector type with
 * none of the distressed weight the real thumbnails have, and a procedural
 * grunge attempt that looked like mould rather than print wear.
 *
 * The operator's evidence beats the theory. This prompt has been rendering
 * headlines correctly, week after week, in a style the compositor could not
 * reach. So the model does the whole image, and the misspelling risk is handled
 * where it actually belongs: a human looks at the result and regenerates if it
 * is wrong, which is a two-click loop rather than an architecture.
 *
 * ## The two files
 *
 * The master carries logo, tagline and headline. The square carries none of
 * them and must read as the same artwork — that is the consistency rule, and it
 * is why both are generated from one brief rather than independently.
 */

/** The look. Verbatim from the working prompt. */
const REFERENCE_STYLE = `Use the established Prather Point thumbnail style: dramatic \
cinematic movie-poster composition, photorealistic subjects, extremely high contrast, \
deep blacks, dramatic directional lighting, storm clouds, smoke, sparks/embers where \
appropriate, rich red/white/blue accents, gritty distressed textures, and a premium \
political/news/thriller documentary aesthetic. Do not make it look like a generic \
YouTube thumbnail or flat news graphic. The overall result should feel like a \
theatrical political thriller/documentary poster rather than a conventional podcast \
graphic.`;

export interface ThumbnailRequest {
  /** The approved headline. Rendered INTO the image, exactly as supplied. */
  headline: string;
  guestName?: string | null;
  /** True when a guest photograph is passed as a reference image. */
  hasGuestPhoto?: boolean;
  /** True when the logo file is passed as a reference image. */
  hasLogoReference?: boolean;
  /** Operator steer on a regeneration — "darker", "lose the flag". */
  note?: string | null;
}

/**
 * FILE 1 — the master. 16:9, with logo, tagline and headline.
 *
 * The headline instruction is emphatic about exact wording and spelling because
 * that is the one failure mode that makes an otherwise good frame unusable, and
 * it is the line the working prompt already carried.
 */
export function buildMasterPrompt(request: ThumbnailRequest): string {
  const parts: string[] = [];

  parts.push(
    `Create a thumbnail for an episode of The Prather Point, an intelligence and ` +
      `current-affairs broadcast.`,
  );
  parts.push(`EPISODE HEADLINE: "${request.headline}"`);
  parts.push(REFERENCE_STYLE);

  parts.push(
    `Include:
• The Prather Point logo in the upper-left${
      request.hasLogoReference
        ? ", reproduced exactly from the supplied logo image — do not redraw, restyle or re-letter it"
        : ""
    }.
• The tagline "FREEDOM IS TAKEN" beneath the logo.
• Large, extremely readable headline typography on the LEFT side.
• Condensed, distressed, bold uppercase typography.
• The headline should occupy roughly 40-45% of the composition.
• Red, white, and occasional gold/yellow emphasis.
• Main subjects dominate the CENTRE and RIGHT.
• Keep important faces and objects large enough to read at thumbnail size.
• Strong foreground / middle ground / background depth.
• Avoid tiny decorative elements that will disappear at small sizes.
• Do not change or paraphrase the supplied headline.
• Spell every word correctly.`,
  );

  if (request.guestName) {
    parts.push(
      request.hasGuestPhoto
        ? `The guest is ${request.guestName}, shown in the supplied reference photograph. ` +
          `Render that person faithfully — same face, build and likeness — lit and graded ` +
          `to match the scene. Do not substitute a different person.`
        : `The guest is ${request.guestName}, but no reference photograph was supplied. ` +
          `Do NOT invent their likeness — an invented face for a real person is worse than ` +
          `none. Build the image from the subject matter instead.`,
    );
  } else {
    // Jeff is deliberately never depicted; episodes without a guest carry the topic.
    parts.push(
      `There is no guest. Do not depict any identifiable real person. Build the imagery ` +
        `from the subject matter of the headline — the places, objects, symbols and ` +
        `atmosphere it implies.`,
    );
  }

  if (request.note?.trim()) {
    parts.push(`Additional direction: ${request.note.trim()}`);
  }

  return parts.join("\n\n");
}

/**
 * FILE 2 — the square companion. Same artwork, no type at all.
 *
 * The prohibition is stated at length because a model given a poster brief will
 * caption it unless told repeatedly not to, and one stray word makes the file
 * unusable as podcast artwork.
 */
export function buildSquarePrompt(request: ThumbnailRequest): string {
  const parts: string[] = [];

  parts.push(
    `A 1:1 square companion image for the same Prather Point episode, derived from the ` +
      `SAME visual concept as the master thumbnail.`,
  );
  parts.push(`The episode is about: "${request.headline}"`);
  parts.push(REFERENCE_STYLE);

  parts.push(
    `CRITICAL:
• NO headline. NO typography. NO logo. NO tagline. NO captions or labels.
• NO additional text anywhere. No letters, no numbers, no lettering on signs or screens.
• Preserve the SAME subjects, background and environment.
• Preserve the SAME lighting, atmosphere, colour grading, weather, smoke, sparks and scenery.
• Do NOT invent a different background. Do NOT introduce unrelated people or objects.
• Recompose the scene intelligently for 1:1 rather than simply cropping a widescreen frame.
• Make the principal subject(s) large and prominent.
• Retain the most important secondary visual elements from the master.
• It must immediately read as the text-free square companion to the master thumbnail.`,
  );

  if (request.guestName && request.hasGuestPhoto) {
    parts.push(
      `The guest is ${request.guestName}, shown in the supplied reference photograph. ` +
        `Render that person faithfully.`,
    );
  } else if (!request.guestName) {
    parts.push(`Do not depict any identifiable real person.`);
  }

  if (request.note?.trim()) {
    parts.push(`Additional direction: ${request.note.trim()}`);
  }

  return parts.join("\n\n");
}

/**
 * What the model renders, and what we deliver.
 *
 * gpt-image-1 offers 1024x1024, 1536x1024 and 1024x1536 — none of which is
 * 16:9. The master is therefore generated at 1536x1024 and resized to the
 * 1920x1080 the working prompt specifies. The prompt already keeps the headline
 * left and the subjects centre-right, so the vertical crop takes sky and floor.
 */
export const MASTER_REQUEST_SIZE = "1536x1024" as const;
export const SQUARE_REQUEST_SIZE = "1024x1024" as const;
export const MASTER_OUTPUT = { width: 1920, height: 1080 } as const;
export const SQUARE_OUTPUT = { width: 1024, height: 1024 } as const;
