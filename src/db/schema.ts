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
  customType,
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
  "PRINTFUL",
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

/**
 * A single fact a provider told us about a broadcast. Deliberately NOT an
 * episode state: an observation is evidence, and evidence is interpreted
 * elsewhere. `OFFLINE` only ever means "a stream we were watching is no longer
 * listed" — Rumble emits no completion event, so its end is inferred.
 */
export const broadcastSignal = pgEnum("broadcast_signal", [
  "SCHEDULED",
  "LIVE",
  "OFFLINE",
  "COMPLETED",
]);

/**
 * Where an episode's pre-stream (placeholder) video stands.
 *
 * Rumble plays a looping placeholder to the audience between the stream being
 * created and the encoder feed arriving. Jeffrey chooses which one runs. There
 * is no API for it — see `docs/PHASE-3-INVESTIGATION.md` §5 — so the Studio
 * tracks the decision and tells the operator to make it real in Rumble Studio.
 */
export const preStreamState = pgEnum("pre_stream_state", [
  "NOT_SELECTED",
  "SELECTED",
  "CONFIRMED_IN_RUMBLE",
  "NOT_APPLICABLE",
]);

/** Recurring, operator-authored description content. Never written by the AI. */
export const standingBlockKind = pgEnum("standing_block_kind", [
  "CTA",
  "SPONSOR",
  "AFFILIATE",
  "CREDENTIAL",
  "DISCLAIMER",
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
  /**
   * When the briefing goes out, as a wall-clock time in `emailSendTimezone`.
   *
   * Stored as a time and a zone rather than an offset or a gap from air, for
   * two reasons that only show up twice a year:
   *
   *  · Arizona does not observe DST, so `America/Phoenix` is -07:00 all year
   *    while the show's Eastern air time shifts. A stored offset would be
   *    right in October and an hour wrong in November.
   *  · The gap between the email and the broadcast therefore CHANGES across
   *    the DST boundary — 11:00 Phoenix is on air in summer and an hour
   *    before it in winter. That is a real editorial fact, not a bug, and
   *    deriving the send time from air time would hide it.
   */
  /**
   * Masthead logo for the briefing, absolute URL. Null uses the app's own
   * copy. It is a setting rather than a constant so the image can be moved to
   * Mailchimp's own hosting without a deploy — an email lives in archives and
   * forwards for years, and the URL in it has to outlive this deployment.
   */
  emailLogoUrl: text("email_logo_url"),
  /**
   * How a merch item's public URL is built, e.g.
   * `https://jeffreyprather.com/shop/{slug}`.
   *
   * A template rather than a derived link because the shop is OURS: Printful
   * fulfils the order but the storefront is part of the website, so the URL
   * scheme is a decision we make rather than a third party's pattern to
   * reverse-engineer. Null means merch has no link yet, and the briefing omits
   * the block rather than linking somewhere that does not exist.
   *
   * Tokens: {slug} {id} {external_id}
   */
  merchUrlTemplate: text("merch_url_template"),
  emailSendTime: text("email_send_time"),
  emailSendTimezone: text("email_send_timezone"),
  /** Real Jeff writing. Seeds the future content engine; nothing reads it yet. */
  aiVoiceProfile: text("ai_voice_profile"),
  aiVoiceNotes: text("ai_voice_notes"),
  /**
   * Which environment this DATABASE is. Claimed by the first worker to
   * connect, then enforced: a worker declaring a different APP_ENV is refused.
   * Deliberately stored here rather than read from the connecting process, so
   * the comparison is against something that process did not supply.
   */
  appEnvironment: text("app_environment"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Merch carried in the briefing.
 *
 * Denormalised from Printful on purpose. The email must render from our own
 * data: a live API call at send time means Printful being slow or down is a
 * briefing that does not go out, and the name and price a subscriber was shown
 * should be the ones that were reviewed, not whatever the store said later.
 */
export const merchItems = pgTable(
  "merch_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showId: uuid("show_id")
      .notNull()
      .references(() => shows.id, { onDelete: "cascade" }),
    /** Printful's sync product id. The join back for a re-sync. */
    printfulId: text("printful_id").notNull(),
    /** The storefront's own id, when the store reports one. */
    externalId: text("external_id"),
    name: text("name").notNull(),
    /** Slugified name, the usual token in a shop URL. */
    slug: text("slug").notNull(),
    imageUrl: text("image_url"),
    price: text("price"),
    currency: text("currency"),
    /** Only featured items appear in the email. Syncing never sets this. */
    featured: boolean("featured").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("merch_items_show_idx").on(t.showId),
    uniqueIndex("merch_items_show_printful_unique").on(t.showId, t.printfulId),
  ],
);

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
    /**
     * Which pre-stream video Jeffrey wants in front of this show, and whether
     * it has actually been set up in Rumble Studio. Two columns because
     * choosing and doing are different facts: the Studio knows the first for
     * certain and can only be told the second.
     */
    /**
     * The guest, when there is one. Jeff never appears in a thumbnail — only
     * guests do — so this is what decides whether artwork is built around a
     * person or around the topic.
     */
    guestName: text("guest_name"),

    /* ------------------------------------------------------- the host's own
     * What Jeff submits before the show, stored VERBATIM.
     *
     * These are not drafts and they are never overwritten by generated copy.
     * His headline seeds alternates; his topics and his brief are used as
     * written, proofread rather than rewritten. The whole point of keeping them
     * in their own columns is that "what Jeff actually said" stays answerable
     * after any amount of editorial work has happened on top.
     */
    hostHeadline: text("host_headline"),
    /** One topic per line, exactly as typed. */
    hostTopics: text("host_topics"),
    /** His own write-up for the email. His voice, his paragraphs. */
    hostBrief: text("host_brief"),
    hostNotes: text("host_notes"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    preStreamAssetId: uuid("pre_stream_asset_id").references(
      () => preStreamAssets.id,
      { onDelete: "set null" },
    ),
    preStreamState: preStreamState("pre_stream_state")
      .notNull()
      .default("NOT_SELECTED"),
    preStreamConfirmedAt: timestamp("pre_stream_confirmed_at", { withTimezone: true }),
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
    /**
     * The transcript this copy was generated from. Packaging is automatic now,
     * so a draft can outlive the material it describes: if the transcript is
     * replaced, anything generated from the old one is describing a recording
     * that is no longer the episode's.
     */
    sourceTranscriptId: uuid("source_transcript_id").references(
      () => episodeTranscripts.id,
      { onDelete: "set null" },
    ),
    /**
     * Set when the source material changed after this draft was written.
     * Approval is NOT revoked — that would silently discard a human decision —
     * but the operator is told the approval now rests on obsolete input.
     */
    staleAt: timestamp("stale_at", { withTimezone: true }),
    staleReason: text("stale_reason"),
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

/* ------------------------------------------------ broadcast observations */

/**
 * What a provider actually told us about a broadcast, and when.
 *
 * This table exists so the workflow survives a restart. The worker cannot rely
 * on having witnessed a transition in memory: it may be down for the minute a
 * stream ends. Persisting the evidence lets the next worker reach the same
 * conclusion the previous one would have.
 *
 * Two deliberate limits:
 *   · Only TRANSITIONS are written, never every poll. A minute-by-minute poll
 *     that keeps reporting "still offline" adds no evidence and would bury the
 *     rows that matter.
 *   · Nothing here is an episode state. These are facts from providers; the
 *     interpretation lives in `lib/domain/broadcast.ts`, and the canonical
 *     episode's relationship to the clock stays with `classifyEpisode`.
 */
export const broadcastObservations = pgTable(
  "broadcast_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null until the observation is matched to a canonical episode. */
    episodeId: uuid("episode_id").references(() => episodes.id, {
      onDelete: "cascade",
    }),
    provider: integrationProvider("provider").notNull(),
    signal: broadcastSignal("signal").notNull(),
    /** The provider's id for the thing observed — a stream id, a video id. */
    externalId: text("external_id"),
    /** When the provider says it happened; falls back to when we saw it. */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    /** Human-readable reason this row exists. Shown in Activity, not a log. */
    summary: text("summary").notNull(),
    detail: jsonb("detail"),
    /**
     * Makes replay safe. A poll that re-reports a transition we already
     * recorded collides here instead of writing a second row, which is what
     * keeps "the worker restarted and re-observed everything" harmless.
     */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("broadcast_observations_dedupe_unique").on(t.dedupeKey),
    index("broadcast_observations_episode_idx").on(t.episodeId, t.observedAt),
    index("broadcast_observations_provider_idx").on(t.provider, t.observedAt),
  ],
);

/* -------------------------------------------------------- pre-stream assets */

/**
 * Reusable pre-stream (placeholder) videos.
 *
 * Rumble's livestream setup takes a placeholder clip of up to 60 seconds that
 * loops until the encoder feed arrives. It is uploaded per stream, so the same
 * file gets used many times — which is exactly why it belongs in its own table
 * rather than as a column on an episode. Jeffrey picks from a small standing
 * set; the episode records WHICH one.
 *
 * NO BINARIES. `sourceUrl` points at wherever the file actually lives (Drive,
 * Dropbox, object storage). Postgres is not a video store, and the operator
 * needs a link they can open and re-upload from, not bytes in a row.
 */
export const preStreamAssets = pgTable(
  "pre_stream_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showId: uuid("show_id")
      .notNull()
      .references(() => shows.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    description: text("description"),
    /** Where the operator can fetch the file to upload it. Never a binary. */
    sourceUrl: text("source_url"),
    /** Rumble caps the placeholder at 60 s; recorded so we can warn, not block. */
    durationSeconds: integer("duration_seconds"),
    /** Retired clips stay for history but stop being offered. */
    active: boolean("active").notNull().default(true),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pre_stream_assets_show_idx").on(t.showId, t.sortOrder)],
);

/* ---------------------------------------------------------- standing blocks */

/**
 * Recurring business content: CTAs, sponsor reads, affiliate links.
 *
 * Phase 2 replaced a whole YouTube description with AI-written copy and in
 * doing so dropped a StreamYard affiliate link that had been in the original.
 * The fix is not to ask the model to remember it — a model asked to reproduce a
 * promo code every episode will eventually get one character wrong. Recurring
 * content is operator-authored, stored verbatim, and composed deterministically
 * around the editorial copy.
 *
 * See `docs/PHASE-3-INVESTIGATION.md` §3 for what is actually recurring in
 * production today, which is much less than expected.
 */
export const standingBlocks = pgTable(
  "standing_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showId: uuid("show_id")
      .notNull()
      .references(() => shows.id, { onDelete: "cascade" }),
    kind: standingBlockKind("kind").notNull(),
    /** Operator-facing name. Not published. */
    label: text("label").notNull(),
    /** Published verbatim. Promo codes and URLs live here untouched. */
    body: text("body").notNull(),
    /**
     * Which platforms this block belongs on. Empty means every platform —
     * a podcast CTA and a "subscribe on YouTube" CTA are not the same text.
     */
    platforms: publicationPlatform("platforms").array(),
    enabled: boolean("enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("standing_blocks_show_idx").on(t.showId, t.sortOrder)],
);

/* -------------------------------------------------------- metric snapshots */

/**
 * Point-in-time provider counters, captured so growth can be measured later.
 *
 * This table exists because of an asymmetry found by measurement, not assumed:
 *
 *   YouTube Analytics BACKFILLS. Asking for a daily series returns history on
 *   demand — three months came back on the first request. Nothing needs to be
 *   captured for it, and duplicating it here would create a second, worse copy
 *   of a series the provider already keeps.
 *
 *   Rumble and Buzzsprout do NOT. Rumble's Live Stream API reports the follower
 *   count RIGHT NOW. Buzzsprout reports `total_plays` RIGHT NOW. Neither offers
 *   a time series and neither can be asked about last Tuesday. Every day that
 *   passes without a snapshot is a day of growth history that cannot be
 *   recovered at any later date.
 *
 * So this captures only what is otherwise lost. It is deliberately not a
 * warehouse: one row per provider per subject per day, counters only, no
 * derived metrics. Anything computable from the rows is computed at read time
 * rather than stored, so a corrected calculation does not need a migration.
 */
export const metricSubject = pgEnum("metric_subject", [
  "CHANNEL",
  "EPISODE",
  "PODCAST",
]);

export const metricSnapshots = pgTable(
  "metric_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: integrationProvider("provider").notNull(),
    subject: metricSubject("subject").notNull(),
    /** The provider's id for the thing counted — a video id, a podcast id. */
    externalId: text("external_id"),
    /** Set when the counter belongs to one of our canonical episodes. */
    episodeId: uuid("episode_id").references(() => episodes.id, {
      onDelete: "cascade",
    }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    /**
     * Raw counters exactly as the provider reported them. Never a rate, never
     * a delta — those are a reading of the data, and readings change.
     */
    counters: jsonb("counters").notNull(),
    /** provider:subject:externalId:YYYY-MM-DD — one capture per day. */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("metric_snapshots_dedupe_unique").on(t.dedupeKey),
    index("metric_snapshots_lookup_idx").on(t.provider, t.subject, t.capturedAt),
    index("metric_snapshots_episode_idx").on(t.episodeId, t.capturedAt),
  ],
);

/* -------------------------------------------------------- worker heartbeats */

/**
 * One row per worker process that has claimed work against this database.
 *
 * Phase 2 found four worker processes competing for jobs, two of them stale
 * from before `ANTHROPIC_API_KEY` existed — so they failed every packaging job
 * they won. Once the worker is responsible for processing a real show
 * automatically, a forgotten laptop worker pointed at production is a genuine
 * hazard rather than an annoyance.
 *
 * The protection is deliberately small: a worker declares the environment it
 * believes it is in, and the queue refuses claims from a worker whose
 * environment does not match the database's. That is enough to stop the actual
 * failure mode without building leases, fencing tokens or a consensus protocol.
 */
export const workerHeartbeats = pgTable(
  "worker_heartbeats",
  {
    /** Stable per process: hostname + pid, or WORKER_ID when set. */
    workerId: text("worker_id").primaryKey(),
    /** What the worker thinks it is connected to: "production", "development". */
    environment: text("environment").notNull(),
    /** Commit or build id, so a stale binary is identifiable on sight. */
    version: text("version"),
    hostname: text("hostname"),
    pid: integer("pid"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastBeatAt: timestamp("last_beat_at", { withTimezone: true }).notNull().defaultNow(),
    jobsClaimed: integer("jobs_claimed").notNull().default(0),
    /** Set when the worker was refused. Surfaced on the Jobs page. */
    rejectedReason: text("rejected_reason"),
  },
  (t) => [index("worker_heartbeats_beat_idx").on(t.lastBeatAt)],
);

/* -------------------------------------------------------------- relations */

/**
 * Images belonging to an episode: an uploaded guest photo, generated artwork,
 * and the composited thumbnails.
 *
 * ## Why the bytes live in Postgres
 *
 * Phase 0 established that the Replit filesystem does not survive a republish,
 * and ruled that media must go to object storage or Postgres — never disk. At
 * this volume Postgres is the right half of that choice: two shows a week, a
 * handful of attempts each, a few megabytes apiece. It needs no new credential,
 * no new provider, and it is backed up with everything else.
 *
 * If the volume ever changes that calculus, `bytes` is the only column that has
 * to move.
 *
 * ## Attempts are kept, not overwritten
 *
 * "Re-run the graphic if it doesn't look right" is a first-class requirement,
 * so a regeneration SUPERSEDES rather than replaces. The operator can look back
 * at what was rejected, and the prompt that produced each one is stored beside
 * it — otherwise "that one was better" is an unanswerable sentence.
 */
export const episodeImageKind = pgEnum("episode_image_kind", [
  /** Uploaded by an operator. The guest's photo, used as a reference. */
  "GUEST_PHOTO",
  /** Generated scene, no text of any kind. The 1:1 companion IS this. */
  "ARTWORK",
  /** Artwork plus logo, tagline and headline. 1920x1080, for YouTube. */
  "THUMBNAIL_16_9",
  /** Square companion, no text. Buzzsprout artwork, WordPress featured image. */
  "THUMBNAIL_1_1",
]);

export const episodeImageState = pgEnum("episode_image_state", [
  "PROPOSED",
  "ACCEPTED",
  "SUPERSEDED",
]);

export const episodeImages = pgTable(
  "episode_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    episodeId: uuid("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    kind: episodeImageKind("kind").notNull(),
    state: episodeImageState("state").notNull().default("PROPOSED"),
    contentType: text("content_type").notNull(),
    bytes: customType<{ data: Buffer; driverData: Buffer }>({
      dataType: () => "bytea",
    })("bytes").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    /** The exact prompt sent, so "that one was better" is answerable. */
    prompt: text("prompt"),
    model: text("model"),
    /** Which ARTWORK a composited thumbnail was built from. */
    derivedFromId: uuid("derived_from_id"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("episode_images_episode_idx").on(t.episodeId, t.kind),
  ],
);

export type EpisodeImage = typeof episodeImages.$inferSelect;
export type EpisodeImageKind = (typeof episodeImageKind.enumValues)[number];

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
export type BroadcastObservation = typeof broadcastObservations.$inferSelect;
export type StandingBlock = typeof standingBlocks.$inferSelect;
export type PreStreamAsset = typeof preStreamAssets.$inferSelect;
export type WorkerHeartbeat = typeof workerHeartbeats.$inferSelect;
export type MetricSnapshot = typeof metricSnapshots.$inferSelect;

export type BroadcastSignal = (typeof broadcastSignal.enumValues)[number];
export type StandingBlockKind = (typeof standingBlockKind.enumValues)[number];
export type PreStreamState = (typeof preStreamState.enumValues)[number];
export type MetricSubject = (typeof metricSubject.enumValues)[number];
