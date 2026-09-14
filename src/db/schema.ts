/**
 * The Prather Point Studio — canonical schema (Phase 1).
 *
 * Two rules govern everything here:
 *
 *   1. ONE EPISODE. An episode exists once. Platforms get `episode_publications`
 *      rows, never their own copy of the episode.
 *   2. AI PREPARES, A HUMAN APPROVES. Generated copy lands in
 *      `episode_content_drafts` as PROPOSED. Nothing downstream may read a draft
 *      that is not APPROVED.
 *
 * Tables the architecture anticipates but that no feature needs yet
 * (transcripts, clips, analytics snapshots, publication revisions, webhook
 * events, media assets, integration credentials) are deliberately absent.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

/* ------------------------------------------------------------------ enums */

export const userRole = pgEnum("user_role", ["OWNER", "EDITOR"]);

export const episodePhase = pgEnum("episode_phase", [
  "PLANNED",
  "SCHEDULED",
  "LIVE",
  "CAPTURING",
  "PRODUCING",
  "REVIEW",
  "RELEASED",
  "ARCHIVED",
]);

/** Small per-episode readiness facets. Deliberately not a second status field —
 *  each answers one question the dashboard has to answer truthfully. */
export const readiness = pgEnum("readiness", ["PENDING", "READY", "MISSING"]);

export const publicationPlatform = pgEnum("publication_platform", [
  "WEBSITE",
  "WORDPRESS",
  "YOUTUBE",
  "RUMBLE",
  "BUZZSPROUT",
  "OPUSCLIP",
  "LOCALS",
  "MAILCHIMP",
]);

/** What a human DECIDED. Separate from `publication_state`, which is what
 *  actually HAPPENED. A deliberate SKIP must never render like a failure. */
export const publicationIntent = pgEnum("publication_intent", [
  "PUBLISH",
  "HOLD",
  "SKIP",
]);

export const publicationState = pgEnum("publication_state", [
  "NOT_STARTED",
  "READY",
  "QUEUED",
  "PROCESSING",
  "SCHEDULED",
  "LIVE",
  "PUBLISHED",
  "FAILED",
  "SKIPPED",
  "AWAITING_MANUAL",
]);

export const draftState = pgEnum("draft_state", [
  "PROPOSED",
  "APPROVED",
  "REJECTED",
  "SUPERSEDED",
]);

export const draftSource = pgEnum("draft_source", ["AI", "HUMAN", "SEED"]);

/**
 * FAILED means "this attempt failed and a retry is scheduled" (attempts <
 * max_attempts, run_after in the future). DEAD means "out of attempts, a human
 * must intervene". The worker claims PENDING *and* FAILED rows whose run_after
 * has passed, which is what makes the Jobs page filters truthful.
 */
export const jobState = pgEnum("job_state", [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "DEAD",
]);

/** Which external service a stored credential belongs to. */
export const integrationProvider = pgEnum("integration_provider", [
  "YOUTUBE",
  "RUMBLE",
  "BUZZSPROUT",
  "MAILCHIMP",
  "OPUSCLIP",
  "LOCALS",
  "WORDPRESS",
]);

export const credentialKind = pgEnum("credential_kind", ["OAUTH", "API_KEY", "URL_SECRET"]);

export const integrationHealth = pgEnum("integration_health", [
  "DISCONNECTED",
  "CONNECTED",
  "ATTENTION",
]);

/**
 * Where a transcript came from. The distinction is load-bearing: YouTube ASR is
 * free but arrives late and is unpunctuated; a paid transcription of our own
 * master is better but costs money. Downstream code reads segments, not source.
 */
export const transcriptSource = pgEnum("transcript_source", [
  "YOUTUBE_ASR",
  "YOUTUBE_MANUAL",
  "WHISPER",
  "UPLOAD",
]);

/* ------------------------------------------------------------------ users */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull().default("EDITOR"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_unique").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the cookie value. The raw token is never stored. */
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/* ------------------------------------------------------------------ shows */

export const shows = pgTable(
  "shows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    tagline: text("tagline"),
    /** Local wall-clock start, e.g. "14:00". Paired with `timezone`. */
    defaultStartTime: text("default_start_time").notNull().default("14:00"),
    timezone: text("timezone").notNull().default("America/New_York"),
    cadenceNote: text("cadence_note"),
    /**
     * Weekdays the show airs, 0 = Sunday … 6 = Saturday. Structured because
     * `cadenceNote` is prose for humans and cannot be computed against — the
     * next-expected-slot calculation needs actual days.
     */
    cadenceDays: integer("cadence_days").array(),
    /** Appears under Jeff's name in email and show notes. */
    credentialLine: text("credential_line"),
    briefLabel: text("brief_label"),
    titlePrefix: text("title_prefix"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("shows_slug_unique").on(t.slug)],
);

export const sponsors = pgTable(
  "sponsors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showId: uuid("show_id")
      .notNull()
      .references(() => shows.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url"),
    offer: text("offer"),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sponsors_show_idx").on(t.showId)],
);

/** Single-row table. Operating defaults live here, never inline in components. */
export const settings = pgTable("settings", {
  id: text("id").primaryKey().default("global"),
  patreonUrl: text("patreon_url"),
  localsUrl: text("locals_url"),
  supportUrl: text("support_url"),
  fromName: text("from_name"),
  replyTo: text("reply_to"),
  mailchimpAudienceId: text("mailchimp_audience_id"),
  defaultCta: text("default_cta"),
  /** Real Jeff writing. Seeds the future content engine; nothing reads it yet. */
  aiVoiceProfile: text("ai_voice_profile"),
  aiVoiceNotes: text("ai_voice_notes"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* --------------------------------------------------------------- episodes */

export const episodes = pgTable(
  "episodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showId: uuid("show_id")
      .notNull()
      .references(() => shows.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    episodeNumber: integer("episode_number"),
    workingTitle: text("working_title").notNull(),
    /** Set only when a headline draft is APPROVED. Null means "not decided". */
    approvedTitle: text("approved_title"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    airedAt: timestamp("aired_at", { withTimezone: true }),
    phase: episodePhase("phase").notNull().default("PLANNED"),
    /** Readiness facets the dashboard reports on. Not a status field. */
    showPrepState: readiness("show_prep_state").notNull().default("PENDING"),
    artworkState: readiness("artwork_state").notNull().default("MISSING"),
    internalNotes: text("internal_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("episodes_slug_unique").on(t.slug),
    index("episodes_show_scheduled_idx").on(t.showId, t.scheduledAt),
    index("episodes_phase_idx").on(t.phase),
  ],
);

/* ----------------------------------------------------------- publications */

export const episodePublications = pgTable(
  "episode_publications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    episodeId: uuid("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    platform: publicationPlatform("platform").notNull(),
    intent: publicationIntent("intent").notNull().default("PUBLISH"),
    state: publicationState("state").notNull().default("NOT_STARTED"),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    /**
     * What the platform's metadata looked like the last time we read it. Two
     * jobs: detect that someone edited the video outside the Studio since our
     * last sync, and give the diff view a "before" that is real rather than
     * assumed. Not a revision history — exactly one snapshot, overwritten.
     */
    remoteSnapshot: jsonb("remote_snapshot"),
    remoteSnapshotAt: timestamp("remote_snapshot_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per episode per platform. This is the database-level guard against
    // double-publishing the same episode to the same place.
    uniqueIndex("episode_publications_episode_platform_unique").on(
      t.episodeId,
      t.platform,
    ),
    index("episode_publications_state_idx").on(t.state),
  ],
);

/* ------------------------------------------------------------ content drafts */

export const episodeContentDrafts = pgTable(
  "episode_content_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    episodeId: uuid("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    /** e.g. "primary_headline", "alternate_headline", "summary_short",
     *  "platform_description", "chapters". */
    field: text("field").notNull(),
    /** Set when the copy is platform-specific (a YouTube description). */
    platform: publicationPlatform("platform"),
    value: text("value").notNull(),
    source: draftSource("source").notNull().default("AI"),
    state: draftState("state").notNull().default("PROPOSED"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Set when an edit replaced this draft, so history stays intact. */
    supersededById: uuid("superseded_by_id"),
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("episode_content_drafts_episode_idx").on(t.episodeId),
    index("episode_content_drafts_state_idx").on(t.state),
  ],
);

/* -------------------------------------------------------------- activity */

export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    episodeId: uuid("episode_id").references(() => episodes.id, {
      onDelete: "cascade",
    }),
    /** Null for machine actors; `actorLabel` then says which. */
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actorLabel: text("actor_label").notNull(),
    /** e.g. "episode.updated", "draft.approved", "publication.intent_changed". */
    verb: text("verb").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id"),
    summary: text("summary").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("activity_events_episode_idx").on(t.episodeId, t.createdAt),
    index("activity_events_created_idx").on(t.createdAt),
  ],
);

/* ------------------------------------------------------------------ jobs */

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    episodeId: uuid("episode_id").references(() => episodes.id, {
      onDelete: "cascade",
    }),
    payload: jsonb("payload").notNull().default({}),
    /** UNIQUE. The database, not calling code, is what prevents double work. */
    idempotencyKey: text("idempotency_key").notNull(),
    state: jobState("state").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    lastError: text("last_error"),
    result: jsonb("result"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jobs_idempotency_key_unique").on(t.idempotencyKey),
    // The claim query's index: (state, run_after).
    index("jobs_claim_idx").on(t.state, t.runAfter),
    index("jobs_episode_idx").on(t.episodeId),
  ],
);

/* ------------------------------------------------- integration credentials */

/**
 * One row per connected provider. The payload is AES-256-GCM ciphertext and is
 * NEVER selected into anything that reaches a client component — see
 * `src/lib/integrations/credentials.ts`, which is the only module allowed to
 * decrypt it.
 */
export const integrationCredentials = pgTable(
  "integration_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: integrationProvider("provider").notNull(),
    kind: credentialKind("kind").notNull(),
    /** Opaque ciphertext. Format: v1.<iv>.<tag>.<ciphertext>, all base64url. */
    encryptedPayload: text("encrypted_payload").notNull(),
    /** Granted OAuth scopes, for display and for detecting a downgrade. */
    scopes: text("scopes").array(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Safe-to-display identity of the connected account. Never a secret. */
    accountLabel: text("account_label"),
    accountExternalId: text("account_external_id"),
    health: integrationHealth("health").notNull().default("DISCONNECTED"),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    /** Latest poll snapshot for the Integrations page. Not analytics history. */
    lastObservation: jsonb("last_observation"),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    connectedBy: uuid("connected_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("integration_credentials_provider_unique").on(t.provider)],
);

/* ------------------------------------------------------------- transcripts */

export const episodeTranscripts = pgTable(
  "episode_transcripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    episodeId: uuid("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    source: transcriptSource("source").notNull(),
    /** e.g. "youtube.captions.download" — the exact mechanism used. */
    provider: text("provider").notNull(),
    language: text("language").notNull().default("en"),
    /** The original payload, unparsed, exactly as the provider returned it. */
    rawText: text("raw_text").notNull(),
    /** The provider's own format, so a re-parse is always possible. */
    rawFormat: text("raw_format").notNull().default("vtt"),
    /** Plain readable text, segments joined. What the content engine reads. */
    plainText: text("plain_text").notNull(),
    sourceExternalId: text("source_external_id"),
    durationSeconds: integer("duration_seconds"),
    segmentCount: integer("segment_count").notNull().default(0),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("episode_transcripts_episode_idx").on(t.episodeId)],
);

export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transcriptId: uuid("transcript_id")
      .notNull()
      .references(() => episodeTranscripts.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    /** Seconds from the start of the recording. Chapters and clips index here. */
    startTime: integer("start_time").notNull(),
    endTime: integer("end_time").notNull(),
    speaker: text("speaker"),
    text: text("text").notNull(),
  },
  (t) => [
    index("transcript_segments_transcript_idx").on(t.transcriptId, t.ordinal),
    uniqueIndex("transcript_segments_ordinal_unique").on(t.transcriptId, t.ordinal),
  ],
);

/* -------------------------------------------------------------- relations */

export const showsRelations = relations(shows, ({ many }) => ({
  episodes: many(episodes),
  sponsors: many(sponsors),
}));

export const episodesRelations = relations(episodes, ({ one, many }) => ({
  show: one(shows, { fields: [episodes.showId], references: [shows.id] }),
  publications: many(episodePublications),
  drafts: many(episodeContentDrafts),
  activity: many(activityEvents),
  jobs: many(jobs),
}));

export const episodePublicationsRelations = relations(
  episodePublications,
  ({ one }) => ({
    episode: one(episodes, {
      fields: [episodePublications.episodeId],
      references: [episodes.id],
    }),
  }),
);

export const episodeContentDraftsRelations = relations(
  episodeContentDrafts,
  ({ one }) => ({
    episode: one(episodes, {
      fields: [episodeContentDrafts.episodeId],
      references: [episodes.id],
    }),
    approver: one(users, {
      fields: [episodeContentDrafts.approvedBy],
      references: [users.id],
    }),
  }),
);

export const episodeTranscriptsRelations = relations(
  episodeTranscripts,
  ({ one, many }) => ({
    episode: one(episodes, {
      fields: [episodeTranscripts.episodeId],
      references: [episodes.id],
    }),
    segments: many(transcriptSegments),
  }),
);

export const transcriptSegmentsRelations = relations(transcriptSegments, ({ one }) => ({
  transcript: one(episodeTranscripts, {
    fields: [transcriptSegments.transcriptId],
    references: [episodeTranscripts.id],
  }),
}));

export const jobsRelations = relations(jobs, ({ one }) => ({
  episode: one(episodes, { fields: [jobs.episodeId], references: [episodes.id] }),
}));

export const activityEventsRelations = relations(activityEvents, ({ one }) => ({
  episode: one(episodes, {
    fields: [activityEvents.episodeId],
    references: [episodes.id],
  }),
  actor: one(users, {
    fields: [activityEvents.actorUserId],
    references: [users.id],
  }),
}));

/* ------------------------------------------------------------------ types */

export type User = typeof users.$inferSelect;
export type Show = typeof shows.$inferSelect;
export type Sponsor = typeof sponsors.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type Episode = typeof episodes.$inferSelect;
export type EpisodePublication = typeof episodePublications.$inferSelect;
export type EpisodeContentDraft = typeof episodeContentDrafts.$inferSelect;
export type ActivityEvent = typeof activityEvents.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type IntegrationCredential = typeof integrationCredentials.$inferSelect;
export type EpisodeTranscript = typeof episodeTranscripts.$inferSelect;
export type TranscriptSegment = typeof transcriptSegments.$inferSelect;

export type UserRole = (typeof userRole.enumValues)[number];
export type EpisodePhase = (typeof episodePhase.enumValues)[number];
export type Platform = (typeof publicationPlatform.enumValues)[number];
export type PublicationIntent = (typeof publicationIntent.enumValues)[number];
export type PublicationState = (typeof publicationState.enumValues)[number];
export type DraftState = (typeof draftState.enumValues)[number];
export type JobState = (typeof jobState.enumValues)[number];
export type Readiness = (typeof readiness.enumValues)[number];
export type IntegrationProvider = (typeof integrationProvider.enumValues)[number];
export type CredentialKind = (typeof credentialKind.enumValues)[number];
export type IntegrationHealth = (typeof integrationHealth.enumValues)[number];
export type TranscriptSource = (typeof transcriptSource.enumValues)[number];
