/**
 * Display vocabulary and derivation rules.
 *
 * The Studio must never make a deliberate SKIP look like a FAILURE. Tone is
 * therefore a first-class property of a state, defined once, here.
 */
import type {
  DraftState,
  EpisodePhase,
  JobState,
  Platform,
  PublicationIntent,
  PublicationState,
  Readiness,
} from "@/db/schema";

export type Tone = "ready" | "waiting" | "progress" | "done" | "problem" | "muted";

export const PLATFORM_LABEL: Record<Platform, string> = {
  WEBSITE: "Website",
  WORDPRESS: "WordPress",
  YOUTUBE: "YouTube",
  RUMBLE: "Rumble",
  BUZZSPROUT: "Buzzsprout",
  OPUSCLIP: "OpusClip",
  LOCALS: "Locals",
  MAILCHIMP: "Mailchimp",
};

/** Order used everywhere a platform list is rendered. */
export const PLATFORM_ORDER: Platform[] = [
  "RUMBLE",
  "YOUTUBE",
  "BUZZSPROUT",
  "MAILCHIMP",
  "WORDPRESS",
  "WEBSITE",
  "OPUSCLIP",
  "LOCALS",
];

export const PUBLICATION_STATE_TONE: Record<PublicationState, Tone> = {
  NOT_STARTED: "muted",
  READY: "ready",
  QUEUED: "progress",
  PROCESSING: "progress",
  SCHEDULED: "waiting",
  LIVE: "progress",
  PUBLISHED: "done",
  FAILED: "problem",
  SKIPPED: "muted",
  AWAITING_MANUAL: "waiting",
};

export const PUBLICATION_STATE_LABEL: Record<PublicationState, string> = {
  NOT_STARTED: "Not started",
  READY: "Ready",
  QUEUED: "Queued",
  PROCESSING: "Processing",
  SCHEDULED: "Scheduled",
  LIVE: "Live",
  PUBLISHED: "Published",
  FAILED: "Failed",
  SKIPPED: "Skipped",
  AWAITING_MANUAL: "Awaiting manual",
};

export const INTENT_LABEL: Record<PublicationIntent, string> = {
  PUBLISH: "Publish",
  HOLD: "Hold",
  SKIP: "Skip",
};

export const PHASE_LABEL: Record<EpisodePhase, string> = {
  PLANNED: "Planned",
  SCHEDULED: "Scheduled",
  LIVE: "Live",
  CAPTURING: "Capturing",
  PRODUCING: "Producing",
  REVIEW: "Review",
  RELEASED: "Released",
  ARCHIVED: "Archived",
};

export const PHASE_TONE: Record<EpisodePhase, Tone> = {
  PLANNED: "muted",
  SCHEDULED: "waiting",
  LIVE: "progress",
  CAPTURING: "progress",
  PRODUCING: "progress",
  REVIEW: "ready",
  RELEASED: "done",
  ARCHIVED: "muted",
};

export const DRAFT_STATE_LABEL: Record<DraftState, string> = {
  PROPOSED: "Proposed",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  SUPERSEDED: "Superseded",
};

export const DRAFT_STATE_TONE: Record<DraftState, Tone> = {
  PROPOSED: "waiting",
  APPROVED: "done",
  REJECTED: "problem",
  SUPERSEDED: "muted",
};

export const JOB_STATE_TONE: Record<JobState, Tone> = {
  PENDING: "waiting",
  RUNNING: "progress",
  SUCCEEDED: "done",
  FAILED: "problem",
  DEAD: "problem",
};

export const READINESS_LABEL: Record<Readiness, string> = {
  PENDING: "Waiting",
  READY: "Ready",
  MISSING: "Missing",
};

export const READINESS_TONE: Record<Readiness, Tone> = {
  PENDING: "waiting",
  READY: "ready",
  MISSING: "problem",
};

/** Human labels for draft `field` keys. */
export const FIELD_LABEL: Record<string, string> = {
  primary_headline: "Primary headline",
  alternate_headline: "Alternate headline",
  summary_short: "Short summary",
  summary_long: "Long summary",
  platform_description: "Description",
  chapters: "Chapters",
  social_caption: "Social caption",
};

export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field.replace(/_/g, " ");
}

/* --------------------------------------------------------- derived status */

export type PackagingStatus = "NONE" | "REVIEW" | "APPROVED";

export const PACKAGING_LABEL: Record<PackagingStatus, string> = {
  NONE: "No drafts",
  REVIEW: "Needs review",
  APPROVED: "Approved",
};

export const PACKAGING_TONE: Record<PackagingStatus, Tone> = {
  NONE: "muted",
  REVIEW: "ready",
  APPROVED: "done",
};

/**
 * Packaging status is DERIVED, never stored. A second stored status field is
 * exactly how a dashboard starts lying.
 */
export function derivePackaging(
  drafts: ReadonlyArray<{ state: DraftState }>,
): PackagingStatus {
  if (drafts.length === 0) return "NONE";
  if (drafts.some((d) => d.state === "PROPOSED")) return "REVIEW";
  if (drafts.some((d) => d.state === "APPROVED")) return "APPROVED";
  return "NONE";
}
