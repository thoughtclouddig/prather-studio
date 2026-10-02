/**
 * The contract for `episode.package`.
 *
 * A JSON Schema handed to the model via `output_config.format`. It guarantees
 * the SHAPE — every field present, correct types, no extra properties.
 *
 * It does NOT constrain array lengths. Structured outputs reject both
 * `minItems` above 1 and `maxItems` outright ("For 'array' type, property
 * 'maxItems' is not supported"), so every count bound lives in two places
 * instead:
 *
 *   · the prompt, which asks for the right number, and
 *   · `validatePackage`, which REJECTS the whole package if the model returns
 *     the wrong number — nothing is written to the database on a violation.
 *
 * So "never more than 5 clips" is still enforced rather than merely requested;
 * the enforcement point is validation, not the API boundary. Keep the two in
 * sync: relaxing the prompt without the validator silently drops the floor.
 */
export const EPISODE_PACKAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "primary_headline",
    "alternate_headlines",
    "summary_short",
    "summary_long",
    "youtube_title",
    "youtube_description",
    "chapters",
    "topics",
    "people",
    "organizations",
    "places",
    "search_terms",
    "clip_candidates",
    "follow_up_topics",
  ],
  properties: {
    primary_headline: {
      type: "string",
      description:
        "The strongest headline for this episode. Specific to what was actually said. No colon-subtitle formula unless it genuinely reads best.",
    },
    alternate_headlines: {
      type: "array",
      items: { type: "string" },
      description:
        "Exactly 3 to 5. Genuinely different angles, not rewordings of the primary.",
    },
    summary_short: {
      type: "string",
      description: "Two to three sentences. What the episode covers and why it matters.",
    },
    summary_long: {
      type: "string",
      description: "One to two paragraphs for the archive page.",
    },
    youtube_title: {
      type: "string",
      description: "At most 100 characters. May match the primary headline if that fits.",
    },
    youtube_description: {
      type: "string",
      description:
        "The full description body WITHOUT a chapter list — chapters are composed in separately at publish time so there is only ever one copy of them.",
    },
    chapters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start_seconds", "title"],
        properties: {
          start_seconds: { type: "integer" },
          title: { type: "string", description: "Short enough to scan. Aim under 55 characters." },
        },
      },
      description:
        "Between 3 and 15. First chapter MUST start at 0. Strictly increasing, at least 10s apart.",
    },
    topics: { type: "array", items: { type: "string" } },
    people: {
      type: "array",
      items: { type: "string" },
      description: "Only people actually named in the recording.",
    },
    organizations: { type: "array", items: { type: "string" } },
    places: { type: "array", items: { type: "string" } },
    search_terms: {
      type: "array",
      items: { type: "string" },
      description: "Phrases a viewer would plausibly search for.",
    },
    clip_candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start_seconds", "end_seconds", "title", "hook", "why_this_moment"],
        properties: {
          start_seconds: { type: "integer" },
          end_seconds: { type: "integer" },
          title: { type: "string" },
          hook: {
            type: "string",
            description: "The opening line of the clip — must be a real line from the transcript.",
          },
          why_this_moment: {
            type: "string",
            description: "One sentence on why this moment earns a clip.",
          },
        },
      },
      description:
        "Exactly 3 to 5 — never more. 30-90 seconds each. Returning more than 5 fails validation and the whole package is discarded.",
    },
    follow_up_topics: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

export interface EpisodePackage {
  primary_headline: string;
  alternate_headlines: string[];
  summary_short: string;
  summary_long: string;
  youtube_title: string;
  youtube_description: string;
  chapters: Array<{ start_seconds: number; title: string }>;
  topics: string[];
  people: string[];
  organizations: string[];
  places: string[];
  search_terms: string[];
  clip_candidates: Array<{
    start_seconds: number;
    end_seconds: number;
    title: string;
    hook: string;
    why_this_moment: string;
  }>;
  follow_up_topics: string[];
}

export class PackageValidationError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
    this.name = "PackageValidationError";
  }
}

/**
 * Structural validation after the fact.
 *
 * Structured outputs guarantee the JSON shape, not that it is sane — a chapter
 * past the end of the recording is schema-valid and still wrong. Anything that
 * fails here never becomes a draft.
 */
export function validatePackage(
  value: unknown,
  opts: { durationSeconds?: number } = {},
): EpisodePackage {
  const problems: string[] = [];
  const pkg = value as EpisodePackage;

  if (!pkg || typeof pkg !== "object") {
    throw new PackageValidationError("Model output was not an object.", ["not an object"]);
  }

  const str = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (!str(pkg.primary_headline)) problems.push("primary_headline is empty");
  if (!str(pkg.summary_short)) problems.push("summary_short is empty");
  if (!str(pkg.youtube_title)) problems.push("youtube_title is empty");
  if (!str(pkg.youtube_description)) problems.push("youtube_description is empty");

  if (pkg.youtube_title && pkg.youtube_title.length > 100) {
    problems.push(`youtube_title is ${pkg.youtube_title.length} characters; YouTube's limit is 100`);
  }

  if (!Array.isArray(pkg.alternate_headlines) || pkg.alternate_headlines.length < 3) {
    problems.push("alternate_headlines needs at least 3 entries");
  }

  // The editorial cap. If this ever fires we have a clip-spam machine.
  if (!Array.isArray(pkg.clip_candidates)) {
    problems.push("clip_candidates missing");
  } else {
    if (pkg.clip_candidates.length < 3 || pkg.clip_candidates.length > 5) {
      problems.push(
        `clip_candidates must be 3–5, got ${pkg.clip_candidates.length}`,
      );
    }
    pkg.clip_candidates.forEach((clip, i) => {
      if (clip.end_seconds <= clip.start_seconds) {
        problems.push(`clip ${i + 1} ends before it starts`);
      }
      const length = clip.end_seconds - clip.start_seconds;
      if (length < 10 || length > 180) {
        problems.push(`clip ${i + 1} is ${length}s; expected roughly 30–90s`);
      }
      if (opts.durationSeconds && clip.end_seconds > opts.durationSeconds + 60) {
        problems.push(`clip ${i + 1} ends past the end of the recording`);
      }
    });
  }

  problems.push(...validateChapters(pkg.chapters, opts.durationSeconds));

  if (problems.length > 0) {
    throw new PackageValidationError(
      `The generated package failed validation: ${problems.join("; ")}`,
      problems,
    );
  }
  return pkg;
}

/** Chapter rules from the brief, applied as validation rather than as hope. */
export function validateChapters(
  chapters: Array<{ start_seconds: number; title: string }> | undefined,
  durationSeconds?: number,
): string[] {
  const problems: string[] = [];
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return ["chapters missing"];
  }
  if (chapters.length < 3) problems.push("YouTube needs at least 3 chapters to render them");
  if (chapters.length > 15) problems.push(`${chapters.length} chapters is too many to scan`);

  if (chapters[0]!.start_seconds !== 0) {
    problems.push("the first chapter must start at 0:00 or YouTube ignores all of them");
  }

  for (let i = 1; i < chapters.length; i++) {
    const previous = chapters[i - 1]!;
    const current = chapters[i]!;
    if (current.start_seconds <= previous.start_seconds) {
      problems.push(`chapter ${i + 1} does not come after chapter ${i}`);
    } else if (current.start_seconds - previous.start_seconds < 10) {
      // YouTube requires chapters to be at least 10 seconds apart.
      problems.push(`chapters ${i} and ${i + 1} are less than 10s apart`);
    }
  }

  if (durationSeconds) {
    const last = chapters[chapters.length - 1]!;
    if (last.start_seconds > durationSeconds) {
      problems.push("the last chapter starts after the recording ends");
    }
  }

  for (const chapter of chapters) {
    if (!chapter.title?.trim()) problems.push("a chapter has an empty title");
    else if (chapter.title.length > 80) {
      problems.push(`chapter title "${chapter.title.slice(0, 30)}…" is too long to scan`);
    }
  }
  return problems;
}
