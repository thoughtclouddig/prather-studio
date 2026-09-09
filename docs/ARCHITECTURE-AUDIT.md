# JeffreyPrather.com → Production Studio
## Architecture & Capability Audit — Phase 0
**Prepared 9 September 2026 · Investigation only, no production code changed**

---

## 0. Headline findings (read this first)

1. **There is no repository to audit.** `/Users/andyrenk/Prather Web New` is empty. This is a greenfield build.
2. **There is real prior art**, in `~/PRATHER MAIL/prather-brief-app` — a working Flask/Replit/Anthropic/Mailchimp app. Its Mailchimp integration and Jeff's voice profile are proven assets. Its storage and auth layers are not.
3. **Rumble cannot be the source of the master.** Rumble exposes a *poll-only Live Stream API* and a *BD-gated push-upload API*. It has **no** endpoint to list videos, retrieve a recording, read a thumbnail, edit metadata, or read analytics, and **no webhooks**. The proposal's assumption that we can "reuse the Rumble thumbnail" downstream is true only because the team *makes* that thumbnail before the show — not because Rumble gives it back.
4. **StreamYard has no API at all.** Officially confirmed. Its Zapier integration exposes webinar-registrant events only — nothing about broadcasts or recordings.
5. **Therefore the master enters from two places, and exactly one of them is manual:** the YouTube simulcast copy (fully API-addressable, gives us the transcript for free) and a human dropping the StreamYard recording into the system once per episode (gives us the archive master we own).
6. **The current site is a better migration source than expected.** WP REST API is open and unauthenticated for reads (606 posts). Episodes already carry title, date, topic bullets, a square Rumble thumbnail and a Rumble embed ID. Buzzsprout (podcast `1762960`, 521 episodes) is already in lockstep with the posts.
7. **The highest-leverage V1 is not the website.** It is the studio — with WordPress demoted to just another publication target. That defers all SEO risk while capturing all the operational gain.

---

## 1. Existing Repository Audit

### 1.1 The working directory

```
/Users/andyrenk/Prather Web New/    →  0 files, 0 directories, not a git repository
```

Nothing exists. There is no framework, routing, database, auth, admin, media handling, env strategy, deploy config, Replit config, integration, content structure, migration work, analytics, tests, job runner, webhook handler, or storage. Every question in Part 1 of the brief answers to "not present."

**Consequence:** no legacy constrains the stack choice, and no existing code can create technical debt. The only debt risk is importing the wrong parts of the prior app.

### 1.2 Prior art — `~/PRATHER MAIL/prather-brief-app`

A complete, deployed Replit application. 1,314 lines. Not in the working directory, but directly relevant: it is the same operator, same show, same approval philosophy, and it already solved one link of the chain.

| File | LOC | What it is | Verdict |
|---|---|---|---|
| `main.py` | 262 | Flask app, 12 routes, Claude call, admin gate | **Rebuild** — pattern is right, framework is wrong |
| `prompt.py` | 88 | `VOICE_SAMPLES` — real Jeff Substack lines + locked system prompt | **REUSE VERBATIM** |
| `mailchimp.py` | 108 | Working Mailchimp: create campaign, PUT content, schedule send | **REUSE** — proven, port to TS |
| `settings.py` | 56 | Sponsors, Patreon URL, from-name, credential line, audience ID | **REUSE the concept**, promote to real tables |
| `store.py` | 96 | `kv(key TEXT PRIMARY KEY, value JSONB)` on Replit Postgres, JSON-file fallback | **DISCARD** — schemaless bag |
| `email_html.py` | 101 | Newsletter HTML builder | **REUSE later** (email workstream) |
| `graphics.py` | 99 | Pillow image generation | Keep for reference |
| `notify.py` | 83 | SMTP via Gmail app password | Replace with a real provider |
| `templates/*` | 397 | Jinja admin + form | Discard |

**Concrete findings worth carrying forward:**

- `main.py:32` pins `MODEL = "claude-opus-4-8"`. A hardcoded model string in the app entrypoint is a maintenance trap — put it in config.
- `main.py:71` defines the structured-output contract: `Brief(headlines: list[str], preview_text: str, brief: str, show_list: list[str])`. **This is exactly the right shape** for the content engine — a typed schema the model must fill, not free text. Carry the pattern into every AI-generated field.
- `settings.py` already contains the real operating constants: show time `2:00 PM ET`, credential line `MAJ, US Army (Ret.) · ex-DIA / DEA`, brief label `Intelligence Brief`, title prefix `TPP`, Mailchimp audience `6f7bc677e9` (~22k), and four live sponsor rows with codes. These are seed data for the new Settings tables, not things to re-derive.
- `mailchimp.py` proves the full Mailchimp path end to end: `POST /campaigns` → `PUT /campaigns/{id}/content` → `POST /campaigns/{id}/actions/schedule`, with datacenter parsed from the key suffix. **Mailchimp is the one integration in this whole project that is already de-risked.**
- `store.py` reveals the Replit deployment reality: `DATABASE_URL` is present when a Postgres DB is attached, and the author explicitly built a fallback because *"persistent storage that SURVIVES Replit republishes."* That comment is the single most important operational note in the codebase — **the filesystem is not durable across republishes.** Any media we accept must go to object storage or Postgres, never to disk.
- `.replit` runs `pip install -q -r requirements.txt && python3 main.py` with `localPort 8080 → externalPort 80`. Single process. No worker, no scheduler, no queue.

**Reusable vs. debt, stated plainly:**

- **Reusable:** the voice profile, the Mailchimp call sequence, the typed-AI-output pattern, the Settings-as-recurring-defaults concept, the "AI prepares / human approves in the destination tool" philosophy.
- **Debt if carried:** the KV store, the JSON-file fallback, single-password auth, the pinned model constant, Flask, and disk persistence.

### 1.3 Other assets on disk

- `~/PRATHER MAIL/prather-*.html/png` — existing email templates and admin mockups (Intel Brief, report cover, form mockup, admin review mockup). Useful as visual reference for the admin design language.
- `~/Downloads/jp-intel-proposal_{1,2,3}.html` — the ThoughtCloud proposal. v3 is the governing document.
- `~/Downloads/system-info-jeffreyprather.com-18-07-2023.txt` — a full WordPress environment dump. Old (2023) but the plugin roster is the best available map of what the site actually does.
- `~/Downloads/1659388458_jeffreyprather_members.csv`, `Publisher-JeffreyPrather-2016.05.01-2023.06.26-*.csv` — historical member/publisher exports.

---

## 2. Existing Site / Content Inventory

### 2.1 Platform facts (measured, not assumed)

| Fact | Value | Source |
|---|---|---|
| WordPress | 6.2.2, PHP 8.0, Percona/MySQL 5.7, Apache | system-info dump |
| Theme | Hello Elementor 2.6.1 (no child theme) | system-info dump |
| Page builder | Elementor + Elementor Pro + 4 addon packs | system-info dump |
| Permalinks | `/%postname%/` | system-info dump |
| Timezone | America/Phoenix | system-info dump |
| SEO | Yoast (`/sitemap_index.xml` live) | fetched |
| Redirects | **Redirection plugin installed** | system-info dump |
| Custom fields | ACF 6.1.7 | system-info dump |
| Commerce | WooCommerce 7.9 + Printful + PayPal + SkyVerge export | system-info dump |
| Donations | Donorbox; Crowdfundly pages | system-info dump / sitemap |
| Email | Mailchimp for WooCommerce 3.0 | system-info dump |
| **WP REST API** | **Open, unauthenticated reads, `X-WP-Total: 606`** | probed live |

### 2.2 Volume

| Sitemap | URLs |
|---|---|
| `post-sitemap.xml` | **607** |
| `page-sitemap.xml` | 35 |
| `product-sitemap.xml` | 78 |
| `product_cat-sitemap.xml` | 19 |
| `e-landing-page-sitemap.xml` | 4 |
| `category-sitemap.xml` | 3 |
| `jet-woo-builder-sitemap.xml` | 1 |
| **Total indexed** | **~747** |

### 2.3 Anatomy of an episode post (verified against a live page)

Checked `/ukraines-spies-just-turned-on-each-other-heres-what-it-means/` (8 Sep 2026):

- **Video:** `<iframe class="rumble" src="https://rumble.com/embed/vdcert/?pub=32fqt">` — the Rumble *embed* ID (`vdcert`), which is **not** the public Rumble slug. Publisher ID `32fqt`.
- **Thumbnail:** `og:image` → `/wp-content/uploads/2026/09/….jpg` at **1254×1254 (square)** — the Rumble show art, uploaded to WordPress by hand.
- **Body:** a bulleted topic list ("CIA's Ukraine, Birthed in Blood Bloodshed, Ends in Same!" …) — Jeff's own show rundown. This is the seed of the episode summary and, notably, is already written *before* air.
- **Audio:** a text link out to the podcast, not a player.
- **Chrome:** newsletter forms (multiple), Support CTA, Patreon link, Locals promo, rotating sponsor banner, previous-episode link.
- **Absent:** chapters, transcript, tags, related episodes, share buttons, next-episode link, structured data for video.

**Archive index** `/past-episodes/`: card list, ~8 visible, no pagination, links out to permalinks.

**Audio** `/audio-only/`: embeds `https://www.buzzsprout.com/1762960.js` (large player). Buzzsprout feed `https://feeds.buzzsprout.com/1762960.rss` carries **521 items**, channel "THE PRATHER POINT", cadence Tue/Thu — and the titles match the WordPress post titles exactly. The audio pipeline is already running and already in sync.

### 2.4 Classification

| Content | Count | Class | Notes |
|---|---|---|---|
| Episode posts | ~606 | **MIGRATE** | Title, date, slug, topic bullets, Rumble embed ID, square thumbnail → canonical `Episode`. Extractable via WP REST API. |
| `/past-episodes/` | 1 | **REBUILD** | Becomes the real archive with search/filter/pagination. Keep the URL. |
| `/audio-only/` | 1 | **REBUILD** | Buzzsprout player + our own episode-linked audio. Keep the URL. |
| Homepage `/` | 1 | **REBUILD** | Live-show state, latest episode, newsletter, support. |
| `/homepage/` | 1 | **INVESTIGATE** | Duplicate/legacy Elementor draft — likely RETIRE, but check for inbound links first. |
| `/watchlive/` | 1 | **REBUILD** | Should become dynamic, driven by the Rumble Live Stream API. |
| `/join-team-america/`, `/join-team-global/` (+ 2 thanks pages) | 4 | **MIGRATE** | Membership funnel. Preserve URLs exactly. |
| `/support/` | 1 | **MIGRATE** | Donorbox embed. Keep. |
| `/shop/`, `/cart/`, `/checkout/`, `/my-account/` + 78 products + 19 cats | ~100 | **EXTERNAL LINK** | **Do not rebuild WooCommerce.** Keep Woo running (subdomain or path) or move to Shopify as a separate, later project. |
| `/business-directory/`, `/biz-directory-application/` | 2 | **INVESTIGATE** | A real product with paying advertisers? If yes it's its own workstream; if dormant, RETIRE. |
| `/taken-jeffrey-prather/` | 1 | **MIGRATE** | Book/film page. |
| `/prather-streaming-network/` | 1 | **INVESTIGATE** | Possibly superseded by the new architecture. |
| `/contact/` | 1 | **REBUILD** | Simple form. |
| `/meme-war/`, `/american-dream/`, `/jase/`, `/gam/`, `/event-reg/`, `/satphone/`, `/checkout-navigating-discount/` | 7 | **INVESTIGATE** | Campaign/sponsor landing pages. Most likely RETIRE-with-redirect; verify traffic first. |
| `/crowdfundly-*` (3) | 3 | **RETIRE** | Plugin artifacts. 301 to `/support/`. |
| `/login/`, `/signup/`, `/user-profile/`, `/password-reset/`, `/edit-account/` | 5 | **RETIRE** | WP membership scaffolding. Public site needs no user accounts in V1. |
| `/lets-keep-in-touch/`, `/thank-you-for-subscribing/` | 2 | **MIGRATE** | Newsletter funnel. |
| `/payment-failed/`, `/payment-confirmation/` | 2 | **EXTERNAL** | Stays with Woo. |
| Christ Chaplaincy, Bujinkan USA, Warrior School | 3 | **EXTERNAL LINK** | Separate domains. Footer links only. |
| Patreon, Locals | 2 | **EXTERNAL LINK** | Nav/CTA only. |
| `/hello-world/` | 1 | **RETIRE** | WP default. |
| ~100 legacy 2020–2022 posts with emoji slugs | ~100 | **MIGRATE (cold)** | e.g. `/freedom-is-taken-%f0%9f%93%b7-%f0%9f%87%ba%f0%9f%87%b8/`. Percent-encoded emoji URLs. Migrate as archive entries; **never rewrite the slugs**. |

### 2.5 SEO rules for this migration

- **Every URL above stays as-is by default.** The permalink structure is `/%postname%/`; the new app must reproduce it exactly.
- **Export the Redirection plugin's rule table before anything else.** There are existing redirects we do not know about, and losing them silently breaks links that currently resolve.
- Preserve Yoast titles/descriptions per URL as an import field; don't regenerate them wholesale for ranking pages.
- The emoji-slug posts must round-trip percent-encoding correctly. This is the most likely place to silently break ~100 URLs.
- Add what's missing rather than changing what exists: `VideoObject` / `PodcastEpisode` structured data, canonical tags, real chapter markup.

---

## 3. Recommended Product Architecture

### 3.1 The governing correction to the proposal

The proposal's flow assumes the chain starts at Rumble. It cannot. Rumble is a **write-only, poll-readable** endpoint: we can learn that a stream is live and get its ID, and we can push a file up if we get BD credentials, but we can never pull a recording, a thumbnail, or an analytic out of it.

The corrected flow:

```
                        JEFF GOES LIVE (StreamYard)
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
          RUMBLE              YOUTUBE LIVE        [local recording]
       (simulcast RTMP)       (simulcast)          (StreamYard file)
              │                    │                    │
     poll Live Stream API     we own the video     ONE HUMAN STEP:
     is_live / id / title     via OAuth            drop file into Studio
     chat / rants / subs           │                    │
              │                    │                    │
              └──────► ┌───────────┴────────────────────┘
                       ▼
        ┌──────────────────────────────────┐
        │      CANONICAL EPISODE           │   ← the only place an episode exists
        │  identity · editorial · media    │
        │  transcript · chapters · assets  │
        └──────────────┬───────────────────┘
                       │
        ┌──────────────┴───────────────┐
        ▼                              ▼
  CONTENT ENGINE                 DISTRIBUTION
  (Claude, from transcript)      (adapters + jobs)
  titles · summary · chapters          │
  descriptions · keywords              │
  clip candidates · social       ┌─────┼──────┬─────────┬─────────┬────────┐
  newsletter copy                ▼     ▼      ▼         ▼         ▼        ▼
        │                    WordPress YouTube Buzzsprout OpusClip Mailchimp Locals
        │                     (REST)   (API)   (API)     (API)    (API)   (manual)
        ▼                        │       │       │         │        │        │
   HUMAN REVIEW  ────────────────┴───────┴───────┴─────────┴────────┴────────┘
   (one screen, ~2 min)                          │
                                                 ▼
                                    EpisodePlatformPublication rows
                                    (status · external id · url · errors)
                                                 │
                                                 ▼
                                        ANALYTICS SNAPSHOTS
                                        (YouTube API · Buzzsprout ·
                                         Rumble live counters only)
                                                 │
        ┌────────────────────────────────────────┘
        ▼
  PUBLIC SITE (jeffreyprather.com)
  reads the SAME Episode rows — no second CMS
```

### 3.2 Three systems, one database

1. **Studio** (private) — the production control center. Where an episode is created, reviewed, approved and dispatched.
2. **Engines** (headless) — ingest, transcript, content, distribution, analytics. Run as background jobs. No UI of their own; they write state the Studio renders.
3. **Public site** — a read-only projection of the same `Episode` rows. There is never a second copy of an episode.

The critical structural decision: **WordPress becomes a distribution target, not the source.** In V1 the Studio pushes a post into WordPress via the WP REST API exactly the way it pushes a video to YouTube. Nothing about the public site changes, no SEO risk is taken, and the canonical data becomes ours immediately. When the new public site is ready, we flip the `wordpress` adapter off and turn the `website` renderer on. That is a config change, not a migration.

---

## 4. Canonical Data Model

Structure only — not an exhaustive field dump.

```
Show ────────────< Episode >──────────── EpisodeAsset
                     │                    (kind: master_video, master_audio,
                     │                     thumbnail, alt_thumbnail, caption_file,
                     │                     clip_video; storage_key, mime, bytes,
                     │                     duration, width/height, checksum)
                     │
                     ├──< EpisodeTranscript >──< TranscriptSegment
                     │      (source: youtube_asr | whisper | upload,      (t_start, t_end,
                     │       language, provider, raw_key, confidence)      speaker, text)
                     │
                     ├──< EpisodeChapter        (t_start, title, ordinal, origin: ai|human)
                     ├──< EpisodeTopic          (kind: topic|person|org|place|keyword, value, salience)
                     ├──< EpisodeSource         (label, url, note)  — links Jeff cited
                     │
                     ├──< EpisodeContentDraft   ← every AI-generated field lands here first
                     │      (field, platform?, value, model, prompt_version,
                     │       state: proposed|approved|rejected|superseded,
                     │       approved_by, approved_at)
                     │
                     ├──< EpisodeClip           (t_start, t_end, title, hook, caption,
                     │      │                    opus_clip_id, score, aspect,
                     │      │                    state: candidate|approved|rejected|published)
                     │      └──< ClipPublication (→ same shape as EpisodePlatformPublication)
                     │
                     ├──< EpisodePlatformPublication ──< PublicationRevision
                     │                                    (snapshot of title/description/tags
                     │                                     at each successful sync — history
                     │                                     is never overwritten)
                     │
                     ├──< EpisodeAnalyticsSnapshot  (platform, captured_at, metric jsonb)
                     └──< ActivityEvent             (actor, verb, subject, before, after, at)

Integration ──< IntegrationCredential   (provider, kind: oauth|api_key, encrypted payload,
     │                                    scopes, expires_at, health, last_ok_at, last_error)
     ├──< WebhookEvent                   (provider, signature_ok, payload, received_at,
     │                                    processed_at, dedupe_key)
     └──< Job                            (kind, episode_id, state, attempts, run_after,
                                          idempotency_key, error, log, started/finished_at)
```

### 4.1 The two entities that carry the whole design

**`EpisodePlatformPublication`** — one row per (episode × platform). This is what makes "one episode, many publications" true rather than aspirational.

```
episode_id, platform, external_id, external_url, external_embed_id,
intent          -- publish | skip | hold        (a human decision, recorded)
state           -- not_started | queued | uploading | scheduled | live
                   | published | failed | skipped
scheduled_for, published_at,
title, description, tags[], platform_meta jsonb,
last_sync_at, sync_state, error_code, error_message,
retry_count, next_retry_at, idempotency_key,
analytics_ref
```

Two things earn their keep here:

- **`intent` is separate from `state`.** "We chose not to put this on Locals" and "Locals failed" must never look the same on a dashboard. The proposal's whole promise — an operator who doesn't have to check six platforms — collapses if a deliberate skip and a silent failure render identically.
- **`external_embed_id` is separate from `external_id`.** Rumble hands back an embed ID (`vdcert`) that is not the public slug. YouTube has a video ID that is also the embed ID. Collapsing these into one column will break the public player on the ~606 migrated episodes.

**`EpisodeContentDraft`** — every AI-written field is a draft row with an approval state, never a value written directly onto `Episode`. This is the structural guarantee behind "no autonomous political-news publishing bot": there is no code path by which a model's output reaches a platform without a row transitioning to `approved` with a `approved_by` set.

### 4.2 Versioning, sized honestly

Full bitemporal history is overengineering here. Two mechanisms are enough:

- **`PublicationRevision`** — append a snapshot on every successful outbound sync. If someone edits a YouTube title in six months, the record of what we originally published survives.
- **`ActivityEvent`** — an append-only log of who did what, with before/after JSON.

Neither requires a versioning framework. Both are just insert-only tables.

---

## 5. Episode Lifecycle

### 5.1 Why a single status field fails

Every failure mode in the brief is a *parallel* state: YouTube published while Buzzsprout failed; transcript still processing while the stream is over; clips pending on a complete episode; metadata generated but unapproved. A single enum cannot represent any of them without lying.

### 5.2 The model that works

**A coarse episode phase** (for humans and sorting) + **independent per-facet states** (for truth).

```
Episode.phase :  planned → scheduled → live → capturing → producing → review → released → archived
```

`phase` is *derived*, never hand-set. It is the minimum of what the facets say.

**Facets, each with its own state machine:**

| Facet | States |
|---|---|
| `capture` | awaiting · live · ended · master_received |
| `transcript` | none · queued · processing · ready · failed |
| `packaging` | none · generating · proposed · **approved** · stale |
| `artwork` | missing · ready |
| per-platform `publication` | not_started · queued · uploading · scheduled · live · published · failed · **skipped** |
| `clips` | none · submitted · processing · candidates_ready · selected · publishing · done |

**Rules that make it truthful:**

1. `phase` never advances past `review` while any facet is `failed`.
2. `packaging` goes `stale` automatically if the transcript is replaced after approval — approval is bound to the input it was given.
3. `skipped` is reachable only by human action, and is a terminal success state, not a failure.
4. Rumble's publication row is special-cased: it is **observed, not driven**. Its state is set by the Live Stream API poller, never by an outbound job. Rumble can legitimately be `published` before we have the master file.

That last rule directly answers "Rumble live before our system receives the final recording." It is not an edge case; it is the normal path, and the model should treat it as such.

---

## 6. Integration Capability Matrix

`YES` = documented & usable · `PARTIAL` = works with a real caveat · `NO` = does not exist · `UNCLEAR` = needs a live test or a sales conversation

| Capability | StreamYard | YouTube | Rumble | Buzzsprout | OpusClip | Locals | Mailchimp |
|---|---|---|---|---|---|---|---|
| Public API exists | **NO** | YES | PARTIAL | YES | YES | **NO** | YES |
| Create / upload | NO | YES | PARTIAL¹ | YES | YES | NO | YES |
| Schedule | NO | YES | UNCLEAR¹ | PARTIAL² | PARTIAL³ | NO | YES |
| Edit metadata after publish | NO | YES | **NO** | YES | n/a | NO | YES |
| Retrieve media / recording | **NO** | PARTIAL⁴ | **NO** | YES | YES | NO | n/a |
| Retrieve transcript / captions | NO | **YES**⁵ | NO | NO | YES⁶ | NO | n/a |
| Detect start / end of stream | NO | YES | **YES**⁷ | n/a | n/a | n/a | n/a |
| Webhooks | NO⁸ | PARTIAL⁹ | **NO** | **NO** | **YES** | NO | YES |
| Analytics | NO | YES | PARTIAL⁷ | PARTIAL¹⁰ | n/a | NO | YES |
| Delete / unpublish | NO | YES | NO | PARTIAL | n/a | NO | YES |
| **API maturity** | **none** | **high** | **low** | **medium** | **medium** | **none** | **high** |

**Footnotes / evidence**

1. **Rumble upload** — `POST https://rumble.com/api/simple-upload.php`, `multipart/form-data`. Params: `access_token` (40 chars), `title`, `description`, `license_type`, `channel_id`, the video file, `thumb`, and caption files (`cc_en`, `cc_fr`, … formats vtt/srt/sbv/stl/sub). Returns `success`, `video_id`, `video_id_int`, `url_monetized`, `embed_url_monetized`, `embed_html_monetized`, `embed_js_monetized`, `errors[]`. **The token is not self-serve — it is obtained by contacting `bd@rumble.com`.** No scheduling parameter is documented. Docs: `player.rumble.com/developers/Rumble-Upload-API.html` (host refused connections from this environment; content corroborated across two independent retrievals and a mirror at `rumbleplayer.com`).
2. **Buzzsprout** — the documented episode fields include `published_at`, so a future timestamp is the scheduling mechanism; a distinct "draft" flag is *not* documented (`private` and `inactive_at` exist). Needs one live test to confirm future-dated behaviour.
3. **OpusClip** — clips can be published or scheduled to *connected social accounts* via the Social Posting endpoint. This is not the same as scheduling to YouTube-as-us.
4. **YouTube** — the Data API has no "download my video" endpoint. We can read every piece of metadata and every caption track, but not the media file. This is why the master must come from StreamYard.
5. **YouTube captions** — `captions.list` (identifies `trackKind: "asr"`) then `captions.download` (200 quota units) works **because Jeff owns the channel**. The widespread 403 "permissions … not sufficient" is the *third-party* case. Owner OAuth is the whole difference, and we will have it. **This is the transcript source. It is free, and it requires no file.**
6. **OpusClip** produces captioned clips; the API returns clip objects with preview and download URLs.
7. **Rumble Live Stream API** — self-serve at `https://rumble.com/account/livestream-api`. Returns `livestreams[]` with `id`, `title`, `created_on`, `is_live`, `categories`, `likes`, `dislikes`, `watching_now`, plus `chat.recent_messages[]`, `chat.recent_rants[]` (max 50 each), and account-level `num_followers`, `num_subscribers`, `num_gifted_subs` with recent lists. **No authentication — the secret is in the URL.** Values under `livestreams` populate **only while live**. Poll-only; no webhooks; no VOD listing; no media; no metadata write. Docs: `rumble.support/help/how-to-use-rumble-s-live-stream-api`.
8. **StreamYard** — official Help Center answer to "Does StreamYard have an open API": no public API. Its Zapier app exposes only *New Registrant*, *Registrants (Specific Webinar)*, and *Update Registrant Status* — webinar registration events, nothing about broadcasts or recordings. `developers.streamyard.com/docs` redirects to the marketing SPA; `api.streamyard.com` redirects to `/blocked`. The API-catalog entries claiming a StreamYard "Broadcasts/Destinations/Recordings API" (apis.io, api-evangelist, apitracker) are **speculative aggregator listings, not real documentation** — I checked the endpoints they cite and none resolve.
9. **YouTube webhooks** — PubSubHubbub push notifications exist for new-video-on-channel. Useful but coarse; polling `videos.list` on our own uploads is more precise for our purpose.
10. **Buzzsprout** — episode objects carry `total_plays`. There is no documented time-series analytics endpoint and no webhooks.

**Quota note (YouTube, current as of 2026):** the default project quota is 10,000 units/day. `videos.insert` was re-priced twice — from ~1,600 units to ~100 (Dec 2025), then moved to **its own bucket at 1 unit per call, capped at 100 uploads/day** (Jun 2026). Two shows a week is nowhere near any limit. The real quota consumers will be analytics polling and `captions.download` (200 units each), both of which are cheap at this volume. Any guide still quoting 1,600 units per upload is two revisions stale.

### 6.1 What this means for "one-click publishing"

| Truly one-click | Needs a handoff |
|---|---|
| YouTube — full packaging + publish + thumbnail + captions | **StreamYard master file** — human drags one file in, once per episode |
| Buzzsprout — audio + notes + artwork + schedule | **Locals** — system drafts the post, human pastes it |
| Mailchimp — draft or scheduled campaign | **Rumble metadata** — set in Rumble's UI at stream setup; we only observe |
| WordPress (interim) — post via REST | **Rumble upload** — only if/when `bd@rumble.com` grants a token |
| OpusClip — submit source, receive scored clips | **Clip selection** — deliberately human (3–5, not 30) |

---

## 7. Integration Adapter Architecture

### 7.1 Capability-declaring adapters, not forced parity

Forcing `publish()` onto Locals and StreamYard would be exactly the "fake integration layer" the brief warns against. Instead each adapter **declares** what it can do, and the UI renders from that declaration.

```
/integrations
  /_core
    types.ts          Capability, PublishRequest, PublishResult, SyncResult
    registry.ts       provider → adapter
    capability.ts     const YOUTUBE_CAPS = { publish:true, schedule:true, updateMeta:true,
                                             retrieveMedia:false, captions:true,
                                             analytics:true, webhooks:'pubsub' }
  /youtube            full adapter
  /buzzsprout         full adapter
  /mailchimp          full adapter (port from prather-brief-app)
  /wordpress          interim adapter (REST) — retired when the new site ships
  /opusclip           submit + webhook receiver
  /rumble             OBSERVER adapter (poll) + optional push-upload
  /locals             MANUAL adapter — renders a copy-ready payload + a checklist
  /streamyard         NOT AN ADAPTER — an ingest surface (file drop)
```

An adapter implements only what it declares. A `ManualAdapter` base class exists specifically so Locals is *honest*: it produces the exact post body, the video reference and the CTA, marks the publication `awaiting_manual`, and gives the operator a "mark as posted, paste the URL" action. The dashboard shows it as a real, tracked step — not a fake green checkmark.

### 7.2 Credentials, tokens, webhooks

- **Storage:** `IntegrationCredential` rows, payload encrypted at rest with a key from the environment (Replit Secrets), never in application config. Nothing provider-side is ever serialized into a client component or a public API response.
- **OAuth:** YouTube only (offline access, refresh token). Refresh on a scheduled job at ~75% of token lifetime, not lazily on first 401 — that way a broken connection surfaces on the Integrations page before it breaks a publish.
- **API keys:** Buzzsprout (`Authorization: Token token=…`), Mailchimp (datacenter parsed from the key suffix — the existing code already does this correctly), OpusClip (Bearer).
- **Rumble Live Stream URL:** it is a bearer secret in URL form. Treat it as a credential: encrypted, never logged, never rendered.
- **Webhook verification:** OpusClip is the only inbound webhook in V1. Verify signature, persist the raw event to `WebhookEvent` *before* processing, dedupe on a provider event ID, and process asynchronously. An unverified event is stored and marked, never actioned.
- **Idempotency:** every outbound publish carries `idempotency_key = hash(episode_id, platform, content_version)`. An adapter must check for an existing `external_id` before creating. This is the only defence against the duplicate-upload failure mode, and it belongs in the adapter contract, not in calling code.
- **Rate limits:** OpusClip 30 req/min per key and 10 credits minimum per project; YouTube unit accounting; Mailchimp per-key concurrency. A shared token-bucket limiter per provider in `_core`.
- **Health:** each adapter exposes `checkHealth()` — a cheap authenticated read. A scheduled job runs it hourly and writes `CONNECTED / ATTENTION / DISCONNECTED` plus `last_ok_at`.
- **Errors:** every adapter maps provider errors to a `{ code, humanMessage, retryable, operatorAction }` shape. The operator sees "YouTube rejected the thumbnail — it must be under 2MB", never a raw 400.

---

## 8. Background Processing Architecture

### 8.1 The Replit constraint, stated concretely

The prior app's own source comment is the evidence: storage had to move to Postgres because the filesystem does not survive a republish. The same reality governs jobs — a Replit Autoscale deployment can be recycled between requests, so **long work must not live inside an HTTP handler.** A 90-minute video upload to YouTube inside a request handler will fail, and will fail intermittently, which is worse.

### 8.2 The least complicated architecture that is still production-worthy

**Postgres-backed job queue + a Reserved VM worker + Replit Scheduled Deployments.** No Redis, no SQS, no BullMQ, no external queue service.

```
Web (Autoscale)          Worker (Reserved VM, always on)     Scheduler (Scheduled Deployment)
─────────────────        ───────────────────────────────     ────────────────────────────────
serves Studio + site     polls `jobs` FOR UPDATE SKIP LOCKED  every 60s  → poll Rumble is_live
enqueues jobs            runs handlers                        every 15m  → refresh publications
receives webhooks        exponential backoff + jitter         hourly     → integration health
returns immediately      writes state + logs                  daily      → analytics snapshots
                                                              daily      → OAuth token refresh
```

`SELECT … FOR UPDATE SKIP LOCKED` gives correct multi-worker claiming in ~20 lines of SQL. It is the boring, right answer at this volume — a few dozen jobs per episode, twice a week.

**Job contract:**

```
kind, episode_id, payload jsonb, idempotency_key (unique),
state: pending|claimed|running|succeeded|failed|dead,
attempts, max_attempts, run_after, claimed_by, claimed_at,
error jsonb, log text, started_at, finished_at
```

- **Retries:** exponential backoff, capped attempts, then `dead` — visible in the Studio with a **Retry** button. A dead job is an operator task, not a silent loss.
- **Idempotency:** unique constraint on `idempotency_key` makes double-enqueue a no-op at the database level.
- **Visibility:** the Studio's job view is a query, not a separate dashboard. The operator sees "YouTube upload — failed 2h ago — thumbnail too large — [Retry]".

**Which work goes where:**

| Trigger | Mechanism |
|---|---|
| Stream started / ended | Scheduled poll of the Rumble Live Stream API (60s) — this is our only reliable lifecycle signal |
| Master file uploaded | Web request enqueues `ingest_master` |
| Transcript | Job: try `captions.download` from YouTube; fall back to Whisper on our master |
| Content generation | Job per field group, writing `EpisodeContentDraft` rows |
| Publish to a platform | One job per publication row, dispatched on human approval |
| Clip processing | Enqueue on approval → OpusClip webhook completes it |
| Analytics | Daily scheduled job |

---

## 9. Transcript + Claude Content Engine

*(Architecture only. Not built in this phase.)*

### 9.1 Transcript sourcing, in priority order

1. **YouTube ASR via `captions.download`** — free, no file needed, arrives within ~an hour of the stream ending, and we are the owner so the 403 that blocks everyone else does not apply to us. **This should be the default.**
2. **Whisper (or equivalent) on our master** — the fallback when YouTube is slow, when ASR quality is poor, or when a show never went to YouTube. Costs money and needs the file, but yields better speaker turns.
3. **Manual upload** — for legacy episodes.

Whichever wins, it lands as one `EpisodeTranscript` with `TranscriptSegment` rows carrying timecodes. Chapters, clips and citations all reference segment timecodes, so nothing downstream cares which source produced them.

### 9.2 The generation contract

Every generated field is a typed schema the model fills — the pattern already proven in `prather-brief-app` with its `Brief` model, scaled up:

```
EpisodePackage {
  primary_headline, alternate_headlines[3..5], episode_angle,
  summary_short, summary_long,
  youtube_description, rumble_description, buzzsprout_show_notes,
  chapters[{ t_start, title }],
  keywords[], people[], organizations[], places[],
  key_claims[],
  clip_candidates[3..5]{ t_start, t_end, why_this_one, title, hook, caption },
  social_captions{ x, facebook, instagram },
  locals_post, newsletter_copy,
  follow_up_topics[]
}
```

Three rules baked into the model, not into a prompt:

- **Everything is a draft.** Output lands in `EpisodeContentDraft` with `state = proposed`. There is no write path from a model to a platform.
- **`prompt_version` and `model` are stored on every draft.** Otherwise "which headline style performs?" (Part 16) is unanswerable — you cannot correlate performance with an approach you didn't record.
- **Clip candidates are capped in the schema.** `clip_candidates` is `3..5`, enforced by the type. The "fewer, better clips" philosophy is a constraint, not a guideline, and constraints belong in the contract. OpusClip may return thirty; the engine's job is to argue for five, with `why_this_one` written per clip so the operator can decide in seconds.

Jeff's voice profile (`prompt.py:VOICE_SAMPLES`) carries over verbatim and gets a real home in Settings so it can grow without a deploy.

---

## 10. Human Approval Model

The operator makes **four decisions per episode**, and no more:

```
1. PREPARE   →  confirm the show, artwork, scheduled time      (~30s, before air)
2. INGEST    →  drop the StreamYard master                     (~10s, after air)
      ⋯ system works: transcript, packaging, drafts ⋯
3. REVIEW    →  approve titles / descriptions / chapters,
                choose which platforms go                      (~2 min)
4. CLIPS     →  pick 3–5 from the candidates                   (~2 min)
```

The dashboard the brief sketches is achievable **only** because of the facet model in §5. Rendering it is a direct read:

```
NEXT SHOW — Thu 11 Sep, 2:00 PM ET
  StreamYard      READY        (operator-confirmed)
  Thumbnail       READY        artwork facet
  Rumble          SCHEDULED    observed, not driven
  Transcript      —            not applicable yet

EPISODE 8 SEP — "Ukraine's spies just turned on each other"
  Transcript      COMPLETE     transcript.ready
  Metadata        REVIEW       packaging.proposed  ← 6 drafts awaiting approval
  Thumbnail       READY        artwork.ready
  Rumble          PUBLISHED    observed · rumble.com/…
  YouTube         READY        publication.queued, intent=publish
  Buzzsprout      READY        publication.queued
  OpusClip        PROCESSING   clips.processing · submitted 14m ago
  Locals          WAITING      publication.awaiting_manual  ← copy ready
  Mailchimp       —            publication.not_started
```

Every cell is one facet's state. Nothing is inferred, nothing is faked, and a deliberate skip renders as `SKIPPED` in grey — visually distinct from `FAILED` in red. That distinction is the difference between a dashboard the operator trusts and one they stop reading.

---

## 11. Admin Information Architecture

Broadly as the brief proposes, with four changes I'd argue for:

**Dashboard** — next show readiness · items awaiting approval · failed jobs & integrations · recent publications · last-episode performance.

**Episodes** — one list, filtered by phase. *Change:* a permanent **"Needs attention"** filter (any failed facet, any dead job, any stale approval) rather than a separate problem-states view. Problems should live in the same list the operator already reads.

**Episode Workspace** — tabs: Editorial · Artwork · Transcript · Chapters · Distribution · Clips · Social · Sources · Analytics · Activity. *Change:* **Review is a mode, not a tab.** The two-minute approval pass must be one screen with everything approvable on it — if approving an episode requires visiting six tabs, the workflow has just recreated the six-platform problem inside our own app.

**Live** — next broadcast, Rumble live state (from the poller), destination checklist, show prep, assets. *Change:* this should be **read-mostly**. We cannot control StreamYard, so this page's job is to tell the truth about what's ready, not to pretend to drive anything.

**Clips** — candidates · approved · rejected · published · performance.

**Analytics** — deferred; see §16.

**Integrations** — per provider: `CONNECTED / ATTENTION / DISCONNECTED`, last successful sync, capability list, recent errors with operator actions, reconnect and test buttons.

**Settings** — shows · templates · publishing defaults · CTA & sponsor defaults · AI instructions and voice samples · users & roles · credentials. *Change:* **Sponsors and CTAs deserve first-class treatment**, not a settings sub-page. They change per campaign, they appear in every description on every platform, and `prather-brief-app` already proves they're structured data (name | url | offer). Model them properly and every platform description composes them automatically.

---

## 12. Public Site Information Architecture

```
/                       live-state hero · latest episode · newsletter · support
/watchlive/             dynamic from Rumble is_live — live player or next-show countdown
/past-episodes/         the real archive: search, filter by topic/person/date, pagination
/audio-only/            podcast home · Buzzsprout player · directory links
/{episode-slug}/        canonical episode page  ← ~606 existing URLs preserved verbatim
/join-team-america/     membership
/support/               donations
/shop/                  → WooCommerce (external, unchanged)
/business-directory/    pending the INVESTIGATE outcome
/taken-jeffrey-prather/ book/film
/contact/
```

**Canonical episode page** — thumbnail, headline, publish date, primary player (Rumble embed), alternate platform links (YouTube, Buzzsprout, Locals), audio player, summary, chapters (deep-linking into the video), transcript or selected excerpts, sources, related clips, related episodes (via shared `EpisodeTopic` rows), share controls, prev/next.

Two things the current site lacks that the canonical model makes free: **chapters that deep-link the player**, and **related-episode discovery via topics/people** across 606 episodes. That archive is a genuine asset currently sitting inert behind a paginate-less list of eight cards.

Every field on that page reads from the same `Episode` row the Studio wrote. There is no export step, no sync, no second CMS.

---

## 13. Visual Direction (constraints only — no design work this phase)

**Public site — evolve, don't replace.** Black/dark dominant; cinematic imagery; bold condensed typography; red/white/blue as accent, never as decoration; episode artwork treated as the hero it already is (the square 1254×1254 Rumble art is a strong, consistent, recognizable asset — the new grid should be built around square art, not fight it); intelligence/military/documentary register; "Freedom Is Taken" identity intact.

**Explicitly not:** SaaS dashboard, generic Tailwind landing page, Substack clone, news template, floating rounded cards, brand departure.

**Improve:** hierarchy, navigation, type scale and readability, mobile, episode discovery, live-show visibility, newsletter conversion, support conversion, archive usability, consistency between the site and the Rumble/YouTube presence.

**Admin — a different language on purpose.** A broadcast production desk: dense, status-forward, monospaced where data is scanned, high-contrast state colours, keyboard-navigable. It should look like a control room, not like WordPress and not like the public site.

---

## 14. Authentication & Roles

**V1 needs two roles, not five.**

| Role | Can |
|---|---|
| **OWNER** | everything, including integrations, users, and delete |
| **EDITOR** | create/edit episodes, approve content, publish, select clips — **cannot** touch credentials, users, or delete an episode |

That is the real org: Andy operates, Jeff (or a producer) may review. Inventing PRODUCER and VIEWER before anyone occupies them adds authorization surface with no user behind it. Add roles when a person exists who needs one.

**Authorization must be enforced on six verbs**, server-side, at the action layer — never by hiding UI: `edit`, `approve`, `publish`, `delete`, `configure_integrations`, `manage_users`.

**Auth mechanism:** email + password with a proper hash, or a single OAuth provider. **Mandatory second factor for OWNER** — that account can publish to a 22k-subscriber list and a public YouTube channel. The prior app's single shared `ADMIN_PASSWORD` is not adequate for a system with publish authority.

---

## 15. Data Ownership

**Must live permanently in our database, regardless of what any platform does:**

canonical episode metadata · all editorial copy and its approval history · transcripts and segments · chapters · show notes and descriptions per platform · topics/people/organizations · sources · thumbnails · every external ID, URL and embed ID · publication history and revisions · analytics snapshots · activity log.

**Master media — my recommendation: keep it, and keep it cheaply.**

| Asset | Where | Why |
|---|---|---|
| Master video (~2–4 GB/episode) | Object storage, **cold tier** | ~400 GB/yr at two shows/week. Cold storage runs a few dollars a month. This is the cheapest insurance available against losing a platform. |
| Master audio (~60–100 MB) | Object storage, standard tier | Feeds Buzzsprout; small enough to keep hot indefinitely. |
| Thumbnails | Object storage, standard | Tiny, and they *are* the brand. |
| Transcripts, captions | Postgres | Small, queried constantly. |
| Clip renders | Referenced from OpusClip; **archive the approved 3–5 only** | We don't need thirty rejected clips forever. |
| Legacy 606 episodes' video | **Reference only** — keep the Rumble embed ID | We cannot retrieve them from Rumble, and re-hosting isn't possible retroactively. Metadata and thumbnails migrate; video stays embedded. |

The honest position: for the ~606 back-catalogue episodes we can own everything *except* the video, because Rumble will not give it to us. Going forward we can own all of it, because the master passes through our hands on the way in. That asymmetry is worth stating out loud — it is a reason to start capturing masters now rather than later.

---

## 16. Analytics Architecture (design only)

**Collection:** a daily scheduled job writes immutable `EpisodeAnalyticsSnapshot` rows — `(platform, episode_id, captured_at, metrics jsonb)`. Never overwrite; time-series is the whole point, and a snapshot table makes trend questions trivial without a warehouse.

**What each platform can actually give us — tied to §6, not to wishful thinking:**

| Platform | Available |
|---|---|
| YouTube | views, watch time, average view duration, impressions, CTR, **subscribers gained per video**, traffic sources, demographics |
| Buzzsprout | `total_plays` per episode (point-in-time; we build the series by snapshotting) |
| Rumble | live-only: `watching_now`, `likes`, `dislikes`, follower/subscriber counts. **No VOD analytics at all.** |
| Locals | nothing programmatic |
| OpusClip | clip metadata; performance only if published through their social connections |
| Mailchimp | opens, clicks, per-campaign — correlatable to an episode via the publication row |

**Questions we will genuinely be able to answer:** which episodes gained subscribers (YouTube, directly); which topics drive watch time (join snapshots to `EpisodeTopic`); which headline styles perform (only because `EpisodeContentDraft` records the approach used — this is why that table matters); whether publish time matters; which episodes drove email signups.

**Questions we will not be able to answer honestly, and should not fake:** clip-to-full-show conversion *as a measured funnel*. YouTube does not attribute a long-form view to a Short. The best available proxy is correlational — subscriber and view lift on the full episode in the window after clips post — and the UI should label it a correlation, not a conversion. Cross-platform de-duplicated reach is likewise unavailable; Rumble VOD numbers simply do not exist via API.

---

## 17. vidIQ — Recommendation: **DO NOT NEED YET**

vidIQ does now ship a legitimate MCP server (`https://mcp.vidiq.com/mcp`, OAuth or API key, read-only against the channel) offering keyword volume, competition scores, outlier scores, and trending-velocity data. It is a real product, and the proposal's inclusion of it was not unreasonable.

But against **A (our own YouTube Data + Analytics API integration + Claude analysis)**:

- The YouTube Data & Analytics APIs already give us everything vidIQ derives *about our own channel* — impressions, CTR, watch time, subscribers-gained-per-video — for free, and at a per-episode granularity we control.
- The genuinely additive piece is **external keyword demand and competitive benchmarking**, which we cannot compute ourselves.
- However, this channel's bottleneck is not keyword selection. Per the proposal's own scoring, it is **titles/thumbnails (3/10)**, **full videos not posted properly (2/10)**, and **no subscribe ask (2/10)**. Keyword optimization on a video that has no proper title, description or chapters optimizes nothing.
- vidIQ is read-only. It cannot publish, so it never sits on the critical path — which means adding it later costs nothing that adding it now would save.
- As an MCP server it is trivially attachable to the content engine at any point, with no schema or architecture consequence.

**Verdict: DO NOT NEED YET.** Revisit after V1 has run ~10 episodes and we have our own YouTube data showing which titles and topics perform. At that point vidIQ answers a question we'll actually have ("what's the external demand for this topic?") instead of one we're guessing at now. Skipping it also keeps V1 free of a paid dependency.

---

## 18. Security & Reliability

| Risk | Safeguard (proportional, not enterprise) |
|---|---|
| OAuth token leak | Encrypted at rest; never in client bundles, logs, or API responses; scoped to the minimum YouTube scopes |
| YouTube over-permission | Request `youtube.upload` + `youtube.readonly` + `yt-analytics.readonly`; **not** full-account management |
| Rumble Live Stream URL exposure | It is an unauthenticated bearer URL — treat as a credential, redact in all logs and UI |
| Webhook spoofing | Verify OpusClip signatures; persist raw first, process after; dedupe by event ID |
| **Duplicate upload** | Adapter-level idempotency key + a pre-flight check for an existing `external_id`. The single most likely real failure. |
| Duplicate publishing | Unique constraint on `(episode_id, platform)` in `EpisodePlatformPublication` |
| Partial distribution | Per-publication state; **no cross-platform transaction** — never roll back a successful YouTube publish because Buzzsprout failed |
| Deleting an episode vs. a publication | Two separate, differently-authorized actions. Deleting an `Episode` is OWNER-only, soft-delete, and **never** cascades to external platforms. Unpublishing a platform is an explicit per-publication action. |
| API quota exhaustion | Track units per provider per day; back off before the wall; surface on Integrations |
| Provider outage | Retry with backoff → `dead` → visible operator retry. Never fail an episode because a platform is down. |
| Expired credentials | Proactive refresh job + hourly health check → `ATTENTION` on the dashboard before it breaks a publish |
| Admin account compromise | 2FA on OWNER; session expiry; `ActivityEvent` on every state change |
| Unauthorized publishing | Publish authorization checked server-side in the action layer, not the UI |
| **AI content publishing itself** | Structural, not procedural: platform adapters read only from `EpisodeContentDraft` rows in state `approved`. There is no code path from `proposed` to a platform. |
| Audit trail | Append-only `ActivityEvent` + `PublicationRevision` |

---

## 19. Recommended Technical Stack

Your default instinct is right, and the investigation supports it rather than merely permitting it.

| Layer | Recommendation | Why |
|---|---|---|
| Language | **TypeScript**, strict | One language across web, worker and adapters. The typed-schema pattern that makes the AI contract safe is far stronger in TS than in Python. |
| Framework | **Next.js (App Router)** | Server components suit a read-heavy public archive; server actions suit a form-heavy studio; one deployable. |
| Database | **PostgreSQL** (Replit-managed, or Neon) | Already proven in this environment; JSONB covers platform-specific metadata without a schema explosion. |
| ORM | **Drizzle** | SQL-shaped, real migration files, no hidden query behaviour. This schema has ~15 related tables — migrations must be reviewable. |
| Auth | **Auth.js** (credentials or single OAuth) + 2FA for OWNER | Minimal, self-hosted, no vendor. |
| Storage | **S3-compatible object storage** (Cloudflare R2 recommended — zero egress) with presigned direct upload | Multi-GB masters must never pass through a request handler. R2's zero egress matters when the public site serves audio and thumbnails. |
| Jobs | **Postgres queue + Reserved VM worker** | §8. No Redis, no external queue. |
| Scheduling | **Replit Scheduled Deployments** | Native; no extra service. |
| Webhooks | Next.js route handlers → `WebhookEvent` → queue | Verify, persist, defer. |
| Logging | **Structured JSON, Postgres-backed** for job/integration logs | The operator needs to read them in the Studio, not in a vendor console. |
| Errors | **Sentry** (free tier) | The one external service worth adding. |
| Testing | **Vitest** + adapter contract tests against recorded fixtures | Contract tests are the high-value ones — they catch a provider changing its response shape. |
| Environments | Replit dev · staging deployment (separate DB, sandbox creds) · production | **Staging must have its own integration credentials.** Testing a publish against the real YouTube channel is not acceptable. |

**Deliberately not chosen:** Redis/BullMQ, Temporal, a headless CMS, tRPC, a monorepo, microservices, Kubernetes. Each would add a moving part a single developer/operator has to hold in their head, for a system that produces two episodes a week.

**A note on Python:** the prior app is Python and works. But the two things worth keeping from it — the voice profile and the Mailchimp sequence — are ~200 lines that port in an afternoon. That is not a reason to run two languages.

---

## 20. Migration Plan

The ordering principle: **capture the canonical data and the operational leverage first; touch public URLs last.** WordPress keeps serving the site through Phase 4, so no SEO risk is taken until the value is already banked.

| Phase | Scope | Gate to exit |
|---|---|---|
| **0 — Investigation** *(this document)* | Architecture, capability truth, model | ✅ complete |
| **1 — Foundation** | Next.js + Postgres + Drizzle + Auth + roles + job queue + worker + scheduler + Integrations shell + Settings (seeded from `prather-brief-app`) | Worker runs a scheduled job; OWNER can log in; empty Studio deployed |
| **2 — Canonical episode engine** | `Episode` + facets + assets + publications + activity; Episode Workspace; master ingest via presigned upload | An episode can be created, a master ingested, and state read truthfully |
| **3 — WordPress import** | Pull 606 posts + 35 pages via WP REST; parse Rumble embed IDs; import thumbnails; match to Buzzsprout feed by title/date; **export the Redirection rule table** | 606 episodes in the DB with embed IDs and artwork; a URL inventory with a redirect map |
| **4 — First integrations** | YouTube (OAuth, upload, metadata, thumbnail, captions), Buzzsprout, Mailchimp (port), WordPress-as-target, Rumble observer poller | One real episode published to YouTube + Buzzsprout + WordPress from the Studio |
| **5 — Transcript + content engine** | Caption pull, Whisper fallback, `EpisodeContentDraft`, generation schema, Review mode | The two-minute approval pass is real |
| **6 — Clips** | OpusClip submit + webhook, candidate selection UI, clip publications | 3–5 clips selected and tracked per episode |
| **7 — Public site** | Rebuild on the canonical model, URL-for-URL; redirects; structured data | Staged at full parity, verified against the URL inventory |
| **8 — Cutover** | DNS/proxy flip; **keep WooCommerce alive** at `/shop` or a subdomain; monitor 404s and rankings for 30 days | Zero broken canonical URLs |
| **9 — Analytics & optimization** | Snapshots, dashboards, headline/topic performance; revisit vidIQ | Questions in §16 answerable |
| **10 — Locals / email / membership** | Manual-adapter Locals; newsletter generation; membership review | — |

**When the new site can safely replace WordPress:** at the end of Phase 7, and only when three conditions hold — (a) all 606 episode URLs resolve on the new site with matching titles, dates, artwork and working Rumble embeds; (b) the exported Redirection rules are reimplemented and tested; (c) the Studio has published at least 4–6 real episodes end-to-end. Cutting over earlier trades a large, permanent SEO risk for a small schedule gain.

---

## 21. Risks & Unknowns — validate before building

| # | Unknown | How to resolve | Blocks |
|---|---|---|---|
| 1 | Is Jeff's YouTube channel a **simulcast destination** from StreamYard today, and is the channel verified for long uploads and custom thumbnails? | Check channel + StreamYard destinations | The entire transcript strategy. If YouTube isn't live-simulcast, transcripts must come from Whisper on our master — costs money, adds latency, still works. |
| 2 | Does `captions.download` return a usable ASR track for these specific streams? | One live test with owner OAuth | §9 priority order |
| 3 | Does Buzzsprout honour a **future** `published_at` as a schedule? | One API call on a test podcast | Podcast scheduling; fallback is publish-on-approval |
| 4 | What is the current OpusClip **plan**, and does it include API access (Pro Beta / Max / Business)? Credit balance? | Check account | Phase 6. Fallback: keep OpusClip manual, system still tracks clips. |
| 5 | Will `bd@rumble.com` issue an upload access token? | Email them — do this early, it's a human process with unknown latency | Only affects pushing *to* Rumble. Not on the V1 path. |
| 6 | Has the Rumble **Live Stream API** URL been generated at `rumble.com/account/livestream-api`? | Account check | The live-state poller — our only stream lifecycle signal |
| 7 | **How does the StreamYard master actually get out today?** Local recording download? Cloud recording? Who does it? | Watch one episode's real workflow | The one manual step. If nobody currently downloads the recording, this is a new habit and must be designed for, not assumed. |
| 8 | Is the **business directory** a live revenue product? | Ask | Whether it's a workstream or a redirect |
| 9 | What's in the **Redirection** plugin's rule table? | Export | Phase 8 cutover safety |
| 10 | Are the 35 Elementor pages recoverable as clean content, or is the layout locked in Elementor JSON? | Inspect 3–4 via REST | Phase 3 effort estimate — this is the most likely place the import schedule slips |
| 11 | WooCommerce's fate — keep, subdomain, or Shopify? | Business decision | Phase 8 |
| 12 | Locals — is there any partner API, or is manual final? | Ask Locals support | §7 manual adapter is the safe assumption either way |

---

## 22. V1 Recommendation

**V1 = the Episode Desk. Not the website.**

The highest-value operational problem is not that jeffreyprather.com looks dated. It is that every episode currently requires the same scattered manual work across five platforms, and that the YouTube packaging — the thing the proposal identifies as the actual growth blocker — doesn't happen properly because doing it by hand costs more than anyone wants to spend twice a week.

**In V1:**

- Canonical `Episode` + facet state model + activity log
- Master ingest (presigned upload straight to object storage)
- Transcript via YouTube captions, Whisper fallback
- Claude packaging → drafts → **one-screen Review**
- Publish to **YouTube**, **Buzzsprout**, **Mailchimp** (ported, already proven), and **WordPress via REST**
- **Rumble observer** — live state, video ID, chat/rant counters
- Job queue + worker + scheduler + Integrations health page
- Import of all 606 episodes as canonical records
- OWNER / EDITOR roles

**Explicitly not in V1:**

- The public site rebuild — WordPress keeps serving, and gets fed by us
- OpusClip automation — keep clips manual one more cycle; the system tracks them
- Locals adapter
- Analytics dashboards — but **snapshot collection starts in V1**, because you cannot backfill history you didn't capture
- vidIQ
- WooCommerce
- Newsletter *generation* (Mailchimp draft creation ships; AI-written newsletters wait)
- Rumble upload API

**What V1 buys:** every episode fully packaged on YouTube — real title, real description, chapters, tags, the Rumble thumbnail, captions — in about two minutes of human attention, with the canonical archive quietly becoming ours in the background. That directly attacks the 3/10 and 2/10 scores the proposal identified, and it does it without touching a single public URL.

---

## 23. Exact Next Build Step

**The next session builds Phase 1 — Foundation. Nothing else. No integrations, no episode model, no UI beyond the shell.**

Deliverables:

1. **Project scaffold** — Next.js (App Router) + TypeScript strict + Tailwind, in `/Users/andyrenk/Prather Web New`. Initialize git.
2. **Replit config** — `.replit` and deployment config for two targets: the web app (Autoscale) and the worker (Reserved VM). Document the required Secrets; commit **no** credentials.
3. **Database** — Postgres via `DATABASE_URL`, Drizzle with a real `migrations/` directory. Phase-1 tables only: `users`, `sessions`, `settings`, `shows`, `integrations`, `integration_credentials`, `jobs`, `activity_events`.
4. **Auth** — email/password, hashed, OWNER + EDITOR roles, a server-side `authorize(action)` helper used by every mutation. Seed one OWNER from env.
5. **Job queue** — `enqueue()`, `claim()` via `FOR UPDATE SKIP LOCKED`, exponential backoff with jitter, `max_attempts` → `dead`, unique `idempotency_key`. Plus a worker entrypoint that polls and dispatches from a handler registry, and **one trivial handler** (`ping`) proving the loop end to end.
6. **Scheduler** — one Replit Scheduled Deployment that enqueues an `integration_health_check` job, proving the scheduled → queue → worker path works.
7. **Studio shell** — authenticated layout, the broadcast-desk design language established (dark, dense, status-forward), and three real pages: Dashboard (empty states), Jobs (list, filter, **Retry** button), Integrations (registry-driven, all providers `DISCONNECTED`).
8. **Settings** — `shows` and `settings` tables **seeded from `prather-brief-app`**: show time `2:00 PM ET`, credential line, brief label, title prefix, Patreon URL, Mailchimp audience `6f7bc677e9`, the four sponsor rows, and `prompt.py`'s `VOICE_SAMPLES` verbatim into an `ai_voice_profile` field.
9. **Adapter core** — `types.ts`, `capability.ts`, `registry.ts`, and a `Capability` declaration for all eight providers reflecting the §6 matrix. **Declarations only — no provider calls, no SDKs installed.**
10. **Tests** — Vitest, with real coverage on the queue (claim/retry/idempotency/dead-lettering) and on `authorize()`.

**Definition of done:** deployed on Replit; OWNER logs in; the scheduled job fires; the worker claims and runs it; the result appears on the Jobs page; a deliberately failing job retries, dead-letters, and can be retried by hand from the UI.

**Explicitly out of scope for that session:** any `Episode` table, any provider SDK, any OAuth flow, any WordPress import, any public page, any visual design work on the public site.

Answer questions #1, #6 and #7 from §21 before that session starts — they cost minutes and they shape Phase 2.
