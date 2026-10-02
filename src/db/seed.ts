/**
 * Seed data.
 *
 * These are demo episodes written in the show's real register — not lorem
 * ipsum — because the point of this build is to judge the WORKFLOW, and you
 * cannot judge a review screen filled with placeholder text.
 *
 * The seed deliberately produces: one upcoming show, one episode mid-review
 * (the centrepiece), two released episodes, a failed publication, a
 * dead-lettered job, and an edit-and-approve already in the history.
 */
import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "../lib/auth/password";
import { db, sql } from "./client";
import { DestructiveOperationRefused, requireDestructiveAllowed } from "./guard";
import {
  activityEvents,
  episodeContentDrafts,
  episodePublications,
  episodes,
  jobs,
  settings,
  shows,
  sponsors,
  users,
  type Platform,
  type PublicationIntent,
  type PublicationState,
} from "./schema";

/** Real Jeff writing, carried over verbatim from the prior Prather Brief app
 *  (`prompt.py: VOICE_SAMPLES`). Nothing reads it yet — the content engine
 *  arrives in a later phase — but it belongs in the database, not in code. */
const VOICE_PROFILE = `"When Americans realize what the CIA and deep state praetorian guard puppet masters have really done, they will string them up from streetlamps. -JP"

"In Trump land, all people are equal. But some people are more equal than others. And those people's countries are more equal than all others as well. Massie was a lone voice in Congress who committed two unpardonable sins."

"The era of American empire global dominance is over. The doctrine of nuclear weapon superpowers is gone. Replaced by economic logistical strategic reality."

"Lately I've been struck by ever-Trumpers' strange, messianic devotion to POTUS. As if criticizing him is a heretical sin. Now, I know why."

"America has launched Operation Epic Fury in response to Israel's Roaring Lion. But is it justified?"

"I listened to Charlie Kirk's memorial service, and was ashamed."

"Hey ever-Trumpers, DJT is not the messiah. Jesus is."

"The only question remaining is, will the American people fall for yet another false flag?"`;

const ALL_PLATFORMS: Platform[] = [
  "RUMBLE",
  "YOUTUBE",
  "BUZZSPROUT",
  "MAILCHIMP",
  "WORDPRESS",
  "WEBSITE",
  "OPUSCLIP",
  "LOCALS",
];

/** 2:00 PM Eastern on a given date, expressed in UTC (EDT = UTC-4 in September). */
const showTime = (iso: string) => new Date(`${iso}T18:00:00.000Z`);
const ago = (days: number, hours = 0) =>
  new Date(Date.now() - days * 86_400_000 - hours * 3_600_000);

async function main() {
  await requireDestructiveAllowed("db:seed:dev");

  console.log("[seed] clearing existing data");

  // Deletes in dependency order rather than TRUNCATE ... CASCADE.
  //
  // The old TRUNCATE listed `users`, and integration_credentials references
  // users, so CASCADE silently emptied it too. That destroyed a real Google
  // refresh token, a real Rumble Live Stream API URL and a real Buzzsprout key
  // every time someone re-seeded — each of which has to be re-authorised by
  // hand, and YouTube's needs a browser consent round-trip.
  //
  // Connections are a property of the ENVIRONMENT, not of the sample data, so
  // the seed now leaves them alone and only drops its own attribution.
  await sql`UPDATE integration_credentials SET connected_by = NULL`;
  await sql`DELETE FROM broadcast_observations`;
  await sql`DELETE FROM transcript_segments`;
  await sql`DELETE FROM episode_transcripts`;
  await sql`DELETE FROM activity_events`;
  await sql`DELETE FROM jobs`;
  await sql`DELETE FROM episode_content_drafts`;
  await sql`DELETE FROM episode_publications`;
  await sql`DELETE FROM episodes`;
  await sql`DELETE FROM standing_blocks`;
  await sql`DELETE FROM sponsors`;
  await sql`DELETE FROM shows`;
  await sql`DELETE FROM sessions`;
  await sql`DELETE FROM users`;
  await sql`DELETE FROM settings`;

  const [kept] = await sql`SELECT count(*)::int AS n FROM integration_credentials`;
  if (kept && Number(kept["n"]) > 0) {
    console.log(`[seed] preserved ${kept["n"]} integration credential(s)`);
  }

  /* ------------------------------------------------------------- users */

  const ownerEmail = process.env.SEED_OWNER_EMAIL ?? "owner@prather.local";
  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? "prather-dev";
  const editorEmail = process.env.SEED_EDITOR_EMAIL ?? "editor@prather.local";
  const editorPassword = process.env.SEED_EDITOR_PASSWORD ?? "prather-dev";

  const [owner, editor] = await db
    .insert(users)
    .values([
      {
        email: ownerEmail,
        name: "Andy Renk",
        role: "OWNER",
        passwordHash: await hashPassword(ownerPassword),
      },
      {
        email: editorEmail,
        name: "Studio Editor",
        role: "EDITOR",
        passwordHash: await hashPassword(editorPassword),
      },
    ])
    .returning();

  /* ------------------------------------------------------ show + settings */

  const [show] = await db
    .insert(shows)
    .values({
      slug: "the-prather-point",
      name: "The Prather Point",
      tagline: "Freedom Is Taken",
      defaultStartTime: "14:00",
      timezone: "America/New_York",
      cadenceNote: "Live Tuesdays & Thursdays, 2:00 PM ET",
      credentialLine: "Jeffrey Prather · MAJ, US Army (Ret.) · ex-DIA / DEA",
      briefLabel: "Intelligence Brief",
      titlePrefix: "TPP",
    })
    .returning();

  await db.insert(settings).values({
    id: "global",
    patreonUrl: "https://www.patreon.com/JeffreyPrather",
    localsUrl: "https://jeffreyprather.locals.com",
    supportUrl: "https://jeffreyprather.com/support/",
    fromName: "Jeff Prather",
    replyTo: "jeff@jeffreyprather.com",
    mailchimpAudienceId: "6f7bc677e9",
    defaultCta:
      "Subscribe and turn on notifications so you don't miss the next briefing — and get the Intelligence Brief in your inbox.",
    aiVoiceProfile: VOICE_PROFILE,
    aiVoiceNotes:
      "Hard, contrarian, patriot-Christian. Short declaratives. Alliteration is characteristic, not accidental. Never soften a claim Jeff made on air.",
  });

  await db.insert(sponsors).values([
    {
      showId: show!.id,
      name: "Satellite Phone Store",
      url: "https://beready123.com/r/",
      offer: "Save 10%, code PRATHER",
      sortOrder: 0,
    },
    {
      showId: show!.id,
      name: "Masculine Man Essentials",
      url: "http://masculinemanessentials.com/JEFFREYPRATHER",
      offer: "10% off, code JP10",
      sortOrder: 1,
    },
    {
      showId: show!.id,
      name: "Nesa's Hemp",
      url: "https://www.nesashemp.com/#ThePratherPoint",
      offer: "10% off, code THEPRATHERPOINT10",
      sortOrder: 2,
    },
    {
      showId: show!.id,
      name: "Stay Brewed Coffee & Roastery",
      url: "https://staybrewed.com/team-america-coffee/",
      offer: "Team America Coffee — fans save 20%",
      sortOrder: 3,
    },
  ]);

  /* --------------------------------------------------------- episodes */

  const [upcoming, inReview, released1, released2] = await db
    .insert(episodes)
    .values([
      {
        showId: show!.id,
        slug: "ukraines-spy-war-turns-inward",
        episodeNumber: 522,
        workingTitle: "Ukraine's spy war turns inward",
        scheduledAt: showTime("2026-09-10"),
        phase: "SCHEDULED",
        showPrepState: "READY",
        artworkState: "READY",
        internalNotes:
          "Rundown from Jeff: SBU vs GUR purge, the Sept 10/11 convergence, Canada's war financing. Sat phone read live in segment two.",
      },
      {
        showId: show!.id,
        slug: "five-us-bases-hit-the-war-trump-wont-admit",
        episodeNumber: 521,
        workingTitle: "Five bases hit — the war nobody will name",
        scheduledAt: showTime("2026-09-08"),
        airedAt: showTime("2026-09-08"),
        phase: "REVIEW",
        showPrepState: "READY",
        artworkState: "READY",
        internalNotes:
          "Strong second half. Clip candidate around the CENTCOM admission. Buzzsprout push failed — see jobs.",
      },
      {
        showId: show!.id,
        slug: "why-dea-doj-and-cia-slandered-to-silence-me",
        episodeNumber: 520,
        workingTitle: "Why they came after me",
        approvedTitle: "Why DEA, DOJ and CIA Slandered to Silence Me!",
        scheduledAt: showTime("2026-09-03"),
        airedAt: showTime("2026-09-03"),
        phase: "RELEASED",
        showPrepState: "READY",
        artworkState: "READY",
      },
      {
        showId: show!.id,
        slug: "corruption-breeds-the-incompetence-youre-seeing",
        episodeNumber: 519,
        workingTitle: "Corruption and incompetence",
        approvedTitle:
          "Why Corruption Always Breeds the Incompetence You're Now Seeing Everywhere",
        scheduledAt: showTime("2026-08-27"),
        airedAt: showTime("2026-08-27"),
        phase: "RELEASED",
        showPrepState: "READY",
        artworkState: "READY",
      },
    ])
    .returning();

  /* ----------------------------------------------------- publications */

  type PubSeed = {
    platform: Platform;
    intent?: PublicationIntent;
    state: PublicationState;
    externalId?: string;
    externalUrl?: string;
    publishedAt?: Date;
    scheduledFor?: Date;
    errorMessage?: string;
    lastSyncAt?: Date;
  };

  const insertPubs = async (episodeId: string, seeds: PubSeed[]) => {
    const bySeed = new Map(seeds.map((s) => [s.platform, s]));
    await db.insert(episodePublications).values(
      ALL_PLATFORMS.map((platform) => {
        const s = bySeed.get(platform);
        return {
          episodeId,
          platform,
          intent: s?.intent ?? "PUBLISH",
          state: s?.state ?? "NOT_STARTED",
          externalId: s?.externalId ?? null,
          externalUrl: s?.externalUrl ?? null,
          publishedAt: s?.publishedAt ?? null,
          scheduledFor: s?.scheduledFor ?? null,
          errorMessage: s?.errorMessage ?? null,
          lastSyncAt: s?.lastSyncAt ?? null,
        };
      }),
    );
  };

  // Upcoming: Rumble scheduled (we only ever OBSERVE Rumble), everything else
  // waiting on the recording. OpusClip held until clips are a real workflow.
  await insertPubs(upcoming!.id, [
    { platform: "RUMBLE", state: "SCHEDULED", scheduledFor: showTime("2026-09-10") },
    { platform: "OPUSCLIP", intent: "HOLD", state: "NOT_STARTED" },
    { platform: "LOCALS", state: "NOT_STARTED" },
  ]);

  // In review: the centrepiece. Rumble already live and published before we
  // hold the master — the normal case, not an edge case. Buzzsprout FAILED.
  await insertPubs(inReview!.id, [
    {
      platform: "RUMBLE",
      state: "PUBLISHED",
      externalId: "vdcert",
      externalUrl: "https://rumble.com/embed/vdcert/",
      publishedAt: showTime("2026-09-08"),
      lastSyncAt: ago(0, 3),
    },
    { platform: "YOUTUBE", state: "READY" },
    {
      platform: "BUZZSPROUT",
      state: "FAILED",
      errorMessage:
        "Upload rejected: audio_url returned 404. The master has not been rendered to MP3 yet.",
      lastSyncAt: ago(0, 5),
    },
    { platform: "MAILCHIMP", state: "NOT_STARTED" },
    {
      platform: "WORDPRESS",
      state: "PUBLISHED",
      externalId: "8137",
      externalUrl:
        "https://jeffreyprather.com/five-us-bases-hit-the-war-trump-wont-admit/",
      publishedAt: showTime("2026-09-08"),
      lastSyncAt: ago(0, 6),
    },
    { platform: "WEBSITE", state: "READY" },
    { platform: "OPUSCLIP", intent: "HOLD", state: "NOT_STARTED" },
    { platform: "LOCALS", state: "AWAITING_MANUAL" },
  ]);

  for (const ep of [released1!, released2!]) {
    const aired = ep.airedAt!;
    await insertPubs(ep.id, [
      {
        platform: "RUMBLE",
        state: "PUBLISHED",
        externalId: `v${ep.episodeNumber}rmb`,
        externalUrl: `https://rumble.com/embed/v${ep.episodeNumber}rmb/`,
        publishedAt: aired,
        lastSyncAt: aired,
      },
      {
        platform: "YOUTUBE",
        state: "PUBLISHED",
        externalId: `yt_${ep.slug.slice(0, 11)}`,
        externalUrl: `https://www.youtube.com/watch?v=demo${ep.episodeNumber}`,
        publishedAt: aired,
        lastSyncAt: aired,
      },
      {
        platform: "BUZZSPROUT",
        state: "PUBLISHED",
        externalId: `1762960-${ep.episodeNumber}`,
        externalUrl: `https://www.buzzsprout.com/1762960/episodes/${ep.episodeNumber}`,
        publishedAt: aired,
        lastSyncAt: aired,
      },
      {
        platform: "MAILCHIMP",
        state: "PUBLISHED",
        externalId: `camp_${ep.episodeNumber}`,
        publishedAt: aired,
        lastSyncAt: aired,
      },
      {
        platform: "WORDPRESS",
        state: "PUBLISHED",
        externalUrl: `https://jeffreyprather.com/${ep.slug}/`,
        publishedAt: aired,
        lastSyncAt: aired,
      },
      { platform: "WEBSITE", state: "PUBLISHED", publishedAt: aired },
      { platform: "OPUSCLIP", intent: "SKIP", state: "SKIPPED" },
      { platform: "LOCALS", intent: "SKIP", state: "SKIPPED" },
    ]);
  }

  /* ---------------------------------------------------------- drafts */

  // The centrepiece: a full packaging set awaiting review.
  await db.insert(episodeContentDrafts).values([
    {
      episodeId: inReview!.id,
      field: "primary_headline",
      value: "Five U.S. Bases Hit: The War Trump Won't Admit He Lost",
      source: "AI",
      state: "PROPOSED",
      model: "claude-opus-5",
      promptVersion: "packaging.v1",
      sortOrder: 0,
    },
    {
      episodeId: inReview!.id,
      field: "alternate_headline",
      value: "They Hit Five Of Our Bases. Nobody In Washington Will Say It.",
      source: "AI",
      state: "PROPOSED",
      model: "claude-opus-5",
      promptVersion: "packaging.v1",
      sortOrder: 1,
    },
    {
      episodeId: inReview!.id,
      field: "alternate_headline",
      value: "The Undeclared War: What CENTCOM Just Admitted",
      source: "AI",
      state: "PROPOSED",
      model: "claude-opus-5",
      promptVersion: "packaging.v1",
      sortOrder: 2,
    },
    {
      episodeId: inReview!.id,
      field: "alternate_headline",
      value: "Five Bases, Zero Headlines — Why The Silence?",
      source: "AI",
      state: "PROPOSED",
      model: "claude-opus-5",
      promptVersion: "packaging.v1",
      sortOrder: 3,
    },
    {
      episodeId: inReview!.id,
      field: "summary_short",
      value:
        "Five American installations were struck and the briefing rooms went quiet. I walk through what CENTCOM actually conceded, who benefits from calling it something other than a war, and why the timing sits inside the September window nobody wants to talk about.",
      source: "AI",
      state: "PROPOSED",
      model: "claude-opus-5",
      promptVersion: "packaging.v1",
      sortOrder: 10,
    },
    {
      episodeId: inReview!.id,
      field: "platform_description",
      platform: "YOUTUBE",
      value: `Five U.S. bases were hit. The Pentagon called it something else.

In this briefing I break down what CENTCOM actually conceded, who gains from refusing to name it a war, and why the timing lands inside a September window that keeps repeating.

Subscribe and turn on notifications so you don't miss the next briefing — I go live Tuesdays and Thursdays at 2 PM ET.

CHAPTERS
00:00 Cold open — what was struck
04:12 What CENTCOM actually admitted
11:40 Why "not a war" is a legal position, not a fact
23:05 The September pattern
34:18 Canada's financing angle
41:50 Team America — what to do this week

Jeffrey Prather · MAJ, US Army (Ret.) · ex-DIA / DEA`,
      source: "AI",
      state: "PROPOSED",
      model: "claude-opus-5",
      promptVersion: "packaging.v1",
      sortOrder: 20,
    },
    {
      episodeId: inReview!.id,
      field: "platform_description",
      platform: "BUZZSPROUT",
      value:
        "Five American installations struck, and a briefing room that will not say the word war. Jeffrey Prather walks through the CENTCOM language, the legal dodge underneath it, and the September pattern that keeps recurring. Support the show at jeffreyprather.com/support.",
      source: "AI",
      state: "PROPOSED",
      model: "claude-opus-5",
      promptVersion: "packaging.v1",
      sortOrder: 21,
    },
    {
      episodeId: inReview!.id,
      field: "chapters",
      value: `00:00 Cold open — what was struck
04:12 What CENTCOM actually admitted
11:40 Why "not a war" is a legal position, not a fact
23:05 The September pattern
34:18 Canada's financing angle
41:50 Team America — what to do this week`,
      source: "AI",
      state: "PROPOSED",
      model: "claude-opus-5",
      promptVersion: "packaging.v1",
      sortOrder: 30,
    },
    {
      episodeId: inReview!.id,
      field: "social_caption",
      value:
        "Five bases hit. Not one briefing will name it. Here's what CENTCOM actually conceded — and why the wording matters more than the strike.",
      source: "AI",
      state: "PROPOSED",
      model: "claude-opus-5",
      promptVersion: "packaging.v1",
      sortOrder: 40,
    },
  ]);

  // Released episode: an approved set, including one edit-and-approve so the
  // supersession trail is visible from the first click.
  const [supersededHeadline] = await db
    .insert(episodeContentDrafts)
    .values({
      episodeId: released1!.id,
      field: "primary_headline",
      value: "How Three Agencies Coordinated To Discredit One Whistleblower",
      source: "AI",
      state: "SUPERSEDED",
      model: "claude-opus-5",
      promptVersion: "packaging.v1",
      sortOrder: 0,
      createdAt: ago(6, 4),
    })
    .returning();

  const [approvedHeadline] = await db
    .insert(episodeContentDrafts)
    .values({
      episodeId: released1!.id,
      field: "primary_headline",
      value: "Why DEA, DOJ and CIA Slandered to Silence Me!",
      source: "HUMAN",
      state: "APPROVED",
      sortOrder: 0,
      approvedBy: owner!.id,
      approvedAt: ago(6, 3),
      createdAt: ago(6, 3),
    })
    .returning();

  await db
    .update(episodeContentDrafts)
    .set({ supersededById: approvedHeadline!.id })
    .where(eq(episodeContentDrafts.id, supersededHeadline!.id));

  await db.insert(episodeContentDrafts).values([
    {
      episodeId: released1!.id,
      field: "summary_short",
      value:
        "The record is public now. I lay out how three federal agencies moved in sequence, what each of them needed the story to be, and what it cost the people who told the truth first.",
      source: "AI",
      state: "APPROVED",
      model: "claude-opus-5",
      promptVersion: "packaging.v1",
      sortOrder: 10,
      approvedBy: owner!.id,
      approvedAt: ago(6, 3),
      createdAt: ago(6, 4),
    },
    {
      episodeId: released1!.id,
      field: "alternate_headline",
      value: "Three Agencies, One Target, Zero Accountability",
      source: "AI",
      state: "REJECTED",
      model: "claude-opus-5",
      promptVersion: "packaging.v1",
      sortOrder: 1,
      createdAt: ago(6, 4),
    },
    {
      episodeId: released2!.id,
      field: "primary_headline",
      value:
        "Why Corruption Always Breeds the Incompetence You're Now Seeing Everywhere",
      source: "AI",
      state: "APPROVED",
      model: "claude-opus-5",
      promptVersion: "packaging.v1",
      sortOrder: 0,
      approvedBy: owner!.id,
      approvedAt: ago(13, 3),
      createdAt: ago(13, 4),
    },
    {
      episodeId: released2!.id,
      field: "summary_short",
      value:
        "Competence is the first casualty of a captured institution. I trace the mechanism — selection, loyalty, then collapse — and show you where it is running right now.",
      source: "AI",
      state: "APPROVED",
      model: "claude-opus-5",
      promptVersion: "packaging.v1",
      sortOrder: 10,
      approvedBy: owner!.id,
      approvedAt: ago(13, 3),
      createdAt: ago(13, 4),
    },
  ]);

  /* ------------------------------------------------------------ jobs */

  const [buzzPub] = await db
    .select()
    .from(episodePublications)
    .where(
      and(
        eq(episodePublications.episodeId, inReview!.id),
        eq(episodePublications.platform, "BUZZSPROUT"),
      ),
    )
    .limit(1);

  await db.insert(jobs).values([
    {
      kind: "simulate.publication",
      episodeId: inReview!.id,
      payload: { publicationId: buzzPub!.id },
      idempotencyKey: `seed:simulate.publication:${buzzPub!.id}`,
      state: "DEAD",
      attempts: 3,
      maxAttempts: 3,
      runAfter: ago(0, 5),
      lastError:
        "Upload rejected: audio_url returned 404. The master has not been rendered to MP3 yet.",
      startedAt: ago(0, 6),
      finishedAt: ago(0, 5),
      createdAt: ago(0, 6),
    },
    {
      kind: "fail-test",
      payload: { note: "Seeded so the dead-letter state is visible immediately." },
      idempotencyKey: "seed:fail-test:1",
      state: "DEAD",
      attempts: 3,
      maxAttempts: 3,
      runAfter: ago(0, 2),
      lastError:
        "fail-test handler failed on purpose (attempt 3 of 3). This job exists to demonstrate retry and dead-lettering.",
      startedAt: ago(0, 2),
      finishedAt: ago(0, 2),
      createdAt: ago(0, 2),
    },
    {
      kind: "ping",
      payload: { note: "worker heartbeat" },
      idempotencyKey: "seed:ping:1",
      state: "SUCCEEDED",
      attempts: 1,
      maxAttempts: 3,
      result: { pong: true },
      startedAt: ago(0, 1),
      finishedAt: ago(0, 1),
      createdAt: ago(0, 1),
    },
  ]);

  /* -------------------------------------------------------- activity */

  await db.insert(activityEvents).values([
    {
      episodeId: released1!.id,
      actorUserId: owner!.id,
      actorLabel: "Andy Renk",
      verb: "draft.edited_and_approved",
      subjectType: "draft",
      subjectId: approvedHeadline!.id,
      summary: "Edited and approved Primary headline",
      before: { value: supersededHeadline!.value, state: "PROPOSED" },
      after: { value: approvedHeadline!.value, state: "APPROVED" },
      createdAt: ago(6, 3),
    },
    {
      episodeId: inReview!.id,
      actorLabel: "system",
      verb: "publication.observed",
      subjectType: "publication",
      summary: "Rumble reported the stream ended; publication marked PUBLISHED",
      after: { platform: "RUMBLE", state: "PUBLISHED" },
      createdAt: ago(1, 2),
    },
    {
      episodeId: inReview!.id,
      actorLabel: "worker:worker-1",
      verb: "job.dead",
      subjectType: "job",
      summary:
        "Job simulate.publication exhausted 3 attempts and was dead-lettered",
      after: { state: "DEAD", platform: "BUZZSPROUT" },
      createdAt: ago(0, 5),
    },
    {
      episodeId: upcoming!.id,
      actorUserId: editor!.id,
      actorLabel: "Studio Editor",
      verb: "episode.updated",
      subjectType: "episode",
      subjectId: upcoming!.id,
      summary: "Updated artworkState",
      before: { artworkState: "MISSING" },
      after: { artworkState: "READY" },
      createdAt: ago(0, 8),
    },
  ]);

  console.log("[seed] done");
  console.log(`[seed]   OWNER  ${ownerEmail} / ${ownerPassword}`);
  console.log(`[seed]   EDITOR ${editorEmail} / ${editorPassword}`);
  await sql.end();
}

main().catch((e) => {
  if (e instanceof DestructiveOperationRefused) {
    console.error(`\n${e.message}`);
    process.exit(2);
  }
  console.error("[seed] failed:", e);
  process.exit(1);
});
